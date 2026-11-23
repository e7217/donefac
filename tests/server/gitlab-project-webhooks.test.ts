import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { GitlabProjectWebhookHistory as History, GitlabProjectWebhookReview as Review } from '../../shared/gitlab-project-webhooks.js';
import type { GitlabSettings, GitlabWebhookStatus, WorkspaceSnapshot } from '../../shared/types.js';

const settingsPath = '/integrations/gitlab';
const reviewPath = `${settingsPath}/project-webhook-review`;
const registerPath = `${settingsPath}/project-webhook-register`;
const historyPath = `${settingsPath}/project-webhook-history`;
const contextPath = '/tools/git';
const publicOrigin = 'https://teamspace.example.test';
const receiverUrl = `${publicOrigin}/api${settingsPath}/webhook`;
const legacySecret = 'synthetic-webhook-shared-secret';
const signingToken = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
const readToken = 'synthetic-gitlab-read-only';
const managementToken = 'synthetic-gitlab-project-manager';
const repositoryId = 42;
const hookPath = `${contextPath}/api/v4/projects/${repositoryId}/hooks`;
const historyHookPath = `${hookPath}/12/events`;
const hookOptions = {
  url: receiverUrl, push_events: true, merge_requests_events: true, pipeline_events: true, deployment_events: true,
  enable_ssl_verification: true,
};
const hook = (id: number, overrides: Record<string, unknown> = {}) => ({
  id, project_id: repositoryId, ...hookOptions, push_events_branch_filter: '', custom_webhook_template: null, alert_status: 'executable', ...overrides,
});

type RemoteCall = { method: string; url: URL; credential: string | string[] | undefined; body: unknown };

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

function reply(response: ServerResponse, value: unknown, status = 200, headers: Record<string, string> = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(value));
}

async function gitlab(t: TestContext, handler: (call: RemoteCall, response: ServerResponse) => void | Promise<void>) {
  const calls: RemoteCall[] = [];
  const server = createServer(async (request, response) => {
    try {
      const body = await Array.fromAsync(request);
      const call = {
        method: request.method ?? '', url: new URL(request.url ?? '/', 'http://localhost'), credential: request.headers['private-token'],
        body: body.length ? JSON.parse(Buffer.concat(body).toString()) as unknown : undefined,
      };
      calls.push(call);
      await handler(call, response);
    } catch (error) {
      if (!response.headersSent && !response.destroyed) reply(response, { error: String(error) }, 500);
      else response.destroy();
    }
  });
  t.after(() => close(server));
  return { url: `${await listen(server)}${contextPath}`, calls };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'teamspace-gitlab-project-webhooks-'));
  const start = () => createApp({ dataDir: directory, outboundWorker: false, gitlabWebhookPublicOrigin: publicOrigin });
  let runtime = start();
  let server = createServer(runtime.app);
  let baseUrl = await listen(server);
  t.after(async () => {
    try { await close(server); }
    finally { runtime.close(); await rm(directory, { recursive: true, force: true }); }
  });
  async function restart() {
    await close(server);
    runtime.close();
    runtime = start();
    server = createServer(runtime.app);
    baseUrl = await listen(server);
  }
  async function call<T>(path: string, body?: unknown, status = 200, method = body === undefined ? 'GET' : 'POST',
    headers: Record<string, string> = {}, signal?: AbortSignal) {
    const response = await fetch(`${baseUrl}/api${path}`, {
      method, signal, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': 'user-seo', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${raw}`);
    for (const credential of [readToken, managementToken, legacySecret, signingToken]) assert.ok(!raw.includes(credential), 'API response exposed a credential');
    return { data: JSON.parse(raw) as T, cacheControl: response.headers.get('cache-control') };
  }
  async function configure(baseUrl: string, overrides: Record<string, unknown> = {}) {
    const { data: { version } } = await call<GitlabSettings>(settingsPath);
    return (await call<GitlabSettings>(settingsPath, {
      expectedVersion: version, baseUrl, projectIds: [repositoryId], token: readToken, webhookSecret: legacySecret, ...overrides,
    }, 200, 'PATCH')).data;
  }
  return { call, configure, directory, restart };
}

const reviewInput = (settings: GitlabSettings, token?: string) => ({ expectedVersion: settings.version, repositoryId, ...(token ? { managementToken: token } : {}) });

function registration(settings: GitlabSettings, reviewed: Review, credential = legacySecret) {
  assert.ok(reviewed.reviewId);
  return { ...reviewInput(settings, managementToken), reviewId: reviewed.reviewId, webhookCredential: credential };
}

test('webhook review is read-only and a matching one-time credential registers the exact receiver once', async t => {
  const remoteHooks: ReturnType<typeof hook>[] = [];
  const source = await gitlab(t, (call, response) => {
    if (call.url.pathname !== hookPath) return reply(response, { error: 'Wrong project' }, 404);
    if (call.credential !== readToken && call.credential !== managementToken) {
      return reply(response, { error: `Redact upstream echo ${call.credential}` }, Number(String(call.credential).split('-').at(-1)) || 403);
    }
    if (call.method === 'GET') {
      const page = call.url.searchParams.get('page');
      if (page === '1') return reply(response, [hook(11, { url: 'https://another.example.test/receiver' })], 200, { 'X-Next-Page': '2' });
      return reply(response, remoteHooks, 200, { 'X-Next-Page': '' });
    }
    remoteHooks.push(hook(12, { token: legacySecret, custom_headers: [{ key: 'Private-Token', value: managementToken }] }));
    reply(response, remoteHooks[0], 201);
  });
  const app = await fixture(t);
  const settings = await app.configure(source.url);
  await app.call(reviewPath, { ...reviewInput(settings), expectedVersion: settings.version + 1 }, 409);
  assert.equal(source.calls.length, 0);
  for (const status of [401, 403, 404, 429]) {
    const token = `synthetic-denied-manager-${status}`;
    const denied = await app.call(reviewPath, reviewInput(settings, token), status);
    assert.ok(!JSON.stringify(denied.data).includes(token));
  }
  const reviewed = await app.call<Review>(reviewPath, reviewInput(settings));
  assert.equal(reviewed.cacheControl, 'no-store');
  assert.equal(reviewed.data.state, 'missing');
  assert.equal(reviewed.data.authMode, 'secret');
  assert.equal(reviewed.data.receiverUrl, receiverUrl);
  assert.equal(reviewed.data.repositoryId, repositoryId);
  assert.equal(reviewed.data.settingsVersion, settings.version);
  assert.deepEqual(source.calls.slice(-2).map(({ method, url, credential }) => [method, url.pathname, url.search, credential]), [
    ['GET', hookPath, '?per_page=100&page=1', readToken], ['GET', hookPath, '?per_page=100&page=2', readToken],
  ]);
  const submitted = registration(settings, reviewed.data);
  await app.call(registerPath, { ...submitted, reviewId: randomUUID() }, 409);
  await app.call(registerPath, { ...submitted, webhookCredential: 'wrong credential' }, 400);
  assert.ok(source.calls.every(call => call.method === 'GET'));

  const saved = await app.call<Review>(registerPath, submitted);
  assert.equal(saved.cacheControl, 'no-store');
  assert.equal(saved.data.state, 'created');
  assert.equal(saved.data.receiverUrl, receiverUrl);
  assert.equal(saved.data.repositoryId, repositoryId);
  assert.equal(saved.data.authMode, 'secret');
  assert.equal(saved.data.hooks[0].deploymentEvents, true);
  const replay = await app.call<Review>(registerPath, submitted);
  assert.equal(replay.data.state, 'configured');
  remoteHooks[0].deployment_events = false;
  const needsDeployment = await app.call<Review>(registerPath, submitted);
  assert.equal(needsDeployment.data.state, 'review');
  assert.equal(needsDeployment.data.hooks[0].deploymentEvents, false);
  assert.equal(needsDeployment.data.reviewId, undefined);
  remoteHooks[0].deployment_events = true;
  remoteHooks[0].url = `${receiverUrl}/?routing=existing`;
  const variant = await app.call<Review>(registerPath, submitted);
  assert.equal(variant.data.state, 'review');
  assert.equal(variant.data.hooks[0].receiverExact, false);
  assert.ok(!JSON.stringify(variant.data).includes('routing=existing'));
  const posts = source.calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url.pathname, hookPath);
  assert.equal(posts[0].url.search, '');
  assert.equal(posts[0].credential, managementToken);
  assert.deepEqual(posts[0].body, { ...hookOptions, token: legacySecret });
  assert.deepEqual((await app.call<GitlabWebhookStatus>(`${settingsPath}/webhook-status`)).data.repositories, [{ repositoryId, lastDelivery: null }]);
  assert.deepEqual((await app.call<GitlabSettings>(settingsPath)).data, settings);
  for (const file of ['teamspace.sqlite', 'teamspace.sqlite-wal']) {
    const path = join(app.directory, file);
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    for (const credential of [managementToken, readToken, legacySecret]) assert.ok(!bytes.includes(credential), `Stored plaintext credential in ${file}`);
  }
});

test('review checks matching hook settings, rejects conflicting pagination and never writes from an incomplete list', async t => {
  let mode: 'match' | 'deployment-unknown' | 'conflict' | 'duplicate' | 'jump' | 'foreign' | 'limit' = 'match';
  let foreignRequests = 0;
  const foreign = await gitlab(t, (_call, response) => { foreignRequests++; reply(response, []); });
  const source = await gitlab(t, (call, response) => {
    const page = Number(call.url.searchParams.get('page'));
    if (mode === 'jump') return reply(response, [], 200, { 'X-Next-Page': '3' });
    if (mode === 'foreign') return reply(response, [hook(17)], 200, { Link: `<${foreign.url}/api/v4/projects/42/hooks?page=2>; rel="next"` });
    if (mode === 'limit') return reply(response, [hook(100 + page)], 200, { 'X-Next-Page': String(page + 1) });
    if (page === 1) return reply(response, [hook(17, mode === 'deployment-unknown' ? { deployment_events: undefined } : {})], 200, { 'X-Next-Page': '2' });
    return reply(response, mode === 'duplicate' ? [hook(17)] : mode === 'conflict'
      ? [hook(18, { push_events_branch_filter: 'main', alert_status: 'temporarily_disabled' })] : [], 200, { 'X-Next-Page': '' });
  });
  const app = await fixture(t);
  const settings = await app.configure(source.url);
  const input = reviewInput(settings, managementToken);
  assert.equal((await app.call<Review>(reviewPath, input)).data.state, 'configured');
  mode = 'deployment-unknown';
  const legacy = (await app.call<Review>(reviewPath, input)).data;
  assert.equal(legacy.state, 'review');
  assert.equal(legacy.hooks[0].deploymentEvents, null);
  assert.equal(legacy.reviewId, undefined);
  mode = 'conflict';
  const conflict = await app.call<Review>(reviewPath, input);
  assert.equal(conflict.data.state, 'review');
  for (const invalid of ['duplicate', 'jump', 'foreign', 'limit'] as const) {
    mode = invalid;
    const first = source.calls.length;
    await app.call(reviewPath, input, 502);
    if (invalid === 'limit') assert.equal(source.calls.length - first, 10);
  }
  assert.equal(foreignRequests, 0);
  assert.ok(source.calls.every(call => call.method === 'GET' && call.url.pathname === hookPath));
});

test('a lost register response is reconciled by reviewing remote state without a second POST', async t => {
  const remoteHooks: ReturnType<typeof hook>[] = [];
  let version = '18.11.2-ee';
  const source = await gitlab(t, (call, response) => {
    if (call.url.pathname === `${contextPath}/api/v4/version`) return reply(response, { version });
    if (call.method === 'GET') return reply(response, remoteHooks, 200, { 'X-Next-Page': '' });
    remoteHooks.push(hook(19));
    response.destroy();
  });
  const app = await fixture(t);
  const settings = await app.configure(source.url, { signingToken });
  const reviewed = (await app.call<Review>(reviewPath, reviewInput(settings, managementToken))).data;
  assert.equal(reviewed.state, 'missing');
  assert.equal(reviewed.authMode, 'signature');
  const submitted = registration(settings, reviewed, signingToken);
  await app.call(registerPath, { ...submitted, webhookCredential: legacySecret }, 400);
  const unsupported = await app.call<{ error: string }>(registerPath, submitted, 422);
  assert.match(unsupported.data.error, /19\.1/);
  assert.ok(source.calls.every(call => call.method === 'GET'));
  version = '19.1.1-ee';
  const lost = await app.call<Review>(registerPath, submitted);
  assert.equal(lost.data.state, 'unknown');
  const reconciled = await app.call<Review>(registerPath, submitted);
  assert.equal(reconciled.data.state, 'configured');
  assert.equal(remoteHooks.length, 1);
  assert.deepEqual(source.calls.filter(call => call.method === 'POST').map(call => call.body), [{ ...hookOptions, signing_token: signingToken }]);
  for (const file of ['teamspace.sqlite', 'teamspace.sqlite-wal']) {
    const path = join(app.directory, file);
    if (existsSync(path)) assert.ok(!readFileSync(path).includes(signingToken), `Stored signing token in ${file}`);
  }
});

test('an unresolved registration blocks another POST and survives restarting Teamspace', async t => {
  let visible = false;
  const source = await gitlab(t, (call, response) => {
    if (call.method === 'GET') return reply(response, visible ? [hook(20)] : [], 200, { 'X-Next-Page': '' });
    response.destroy();
  });
  const app = await fixture(t);
  const settings = await app.configure(source.url);
  const input = reviewInput(settings, managementToken);
  const reviewed = (await app.call<Review>(reviewPath, input)).data;
  const submitted = registration(settings, reviewed);
  assert.equal((await app.call<Review>(registerPath, submitted)).data.state, 'unknown');
  assert.equal((await app.call<Review>(registerPath, submitted)).data.state, 'unknown');
  await app.restart();
  const afterRestart = (await app.call<Review>(reviewPath, input)).data;
  assert.equal(afterRestart.state, 'unknown');
  assert.equal(afterRestart.reviewId, undefined);
  await app.call(registerPath, submitted, 409);
  visible = true;
  assert.equal((await app.call<Review>(reviewPath, input)).data.state, 'configured');
  assert.equal(source.calls.filter(call => call.method === 'POST').length, 1);
});

test('only one registration can recheck and create the same receiver concurrently', async t => {
  const arrived = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let holdNextCheck = false;
  const source = await gitlab(t, async (call, response) => {
    if (call.method === 'POST') return reply(response, hook(21), 201);
    if (holdNextCheck) {
      holdNextCheck = false;
      arrived.resolve();
      await gate.promise;
    }
    reply(response, [], 200, { 'X-Next-Page': '' });
  });
  const app = await fixture(t);
  const settings = await app.configure(source.url);
  const reviewed = (await app.call<Review>(reviewPath, reviewInput(settings, managementToken))).data;
  const submitted = registration(settings, reviewed);
  holdNextCheck = true;
  const first = app.call<Review>(registerPath, submitted);
  try {
    await Promise.race([arrived.promise, first.then(() => { throw new Error('Register returned before checking the upstream'); })]);
    await app.call(registerPath, submitted, 409);
    assert.deepEqual(source.calls.map(call => call.method), ['GET', 'GET']);
  } finally { gate.resolve(); }
  assert.equal((await first).data.state, 'created');
  assert.deepEqual(source.calls.map(call => call.method), ['GET', 'GET', 'POST']);
});

test('a settings change during the registration check prevents a webhook write', async t => {
  const arrived = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let block = false;
  const source = await gitlab(t, async (call, response) => {
    if (call.method === 'GET' && block) {
      arrived.resolve();
      await gate.promise;
    }
    reply(response, [], 200, { 'X-Next-Page': '' });
  });
  const app = await fixture(t);
  const settings = await app.configure(source.url);
  const reviewed = (await app.call<Review>(reviewPath, reviewInput(settings, managementToken))).data;
  block = true;
  const pending = app.call(registerPath, registration(settings, reviewed), 409);
  try {
    await Promise.race([arrived.promise, pending.then(() => { throw new Error('Register returned before checking the upstream'); })]);
    const updated = await app.configure(source.url, { webhookSecret: 'synthetic-other-receiver-secret' });
    assert.ok(updated.version > settings.version);
  } finally { gate.resolve(); }
  await pending;
  assert.ok(source.calls.every(call => call.method === 'GET'));
});

test('delivery history only reads the exact saved hook and exposes a sanitized summary plus the independent local receipt', async t => {
  const confidential = 'private synthetic branch and response';
  const sentAt = '2026-11-23T12:15:00.000Z';
  const source = await gitlab(t, (call, response) => {
    if (call.url.pathname === hookPath) return reply(response, [
      hook(12), hook(13, { url: `${receiverUrl}?routed=123` }), hook(14, { url: 'https://another.example.test/receiver' }),
    ], 200, { 'X-Next-Page': '' });
    assert.equal(call.url.pathname, historyHookPath);
    return reply(response, [
      { id: 17, url: receiverUrl, trigger: 'push_hooks', created_at: sentAt, response_status: '401', execution_duration: 0.125,
        request_headers: { 'X-Gitlab-Token': legacySecret }, request_data: { ref: confidential },
        response_headers: { 'Private-Token': managementToken }, response_body: confidential },
      { id: 16, url: 'https://previous.example.test/receiver', trigger: 'push_hooks', created_at: sentAt, response_status: '200' },
    ], 200, { 'X-Next-Page': '' });
  });
  const app = await fixture(t);
  const settings = await app.configure(source.url);
  const input = { ...reviewInput(settings), hookId: 12 };

  await app.call(historyPath, { ...input, repositoryId: 13 }, 403);
  await app.call(historyPath, { ...input, hookId: '12' }, 400);
  await app.call(`${historyPath}?page=2`, input, 400);
  await app.call(historyPath, { ...input, expectedVersion: settings.version + 1 }, 409);
  assert.equal(source.calls.length, 0);
  for (const hookId of [13, 14, 30]) {
    const { data } = await app.call<{ details?: unknown }>(historyPath, { ...input, hookId }, 404);
    assert.deepEqual(data.details, { reason: 'receiver_changed' });
  }
  assert.deepEqual(source.calls.map(call => call.url.pathname), [hookPath, hookPath, hookPath]);

  const first = await app.call<History>(historyPath, input);
  assert.equal(first.cacheControl, 'no-store');
  assert.equal(first.data.localReceipt, null);
  assert.deepEqual(first.data.attempts, [{ id: 17, event: 'push', status: 401, sentAt, durationMs: 125,
    messageReceipt: { status: 'unavailable' } }]);
  assert.deepEqual([first.data.settingsVersion, first.data.repositoryId, first.data.hookId], [settings.version, repositoryId, 12]);
  assert.ok(!JSON.stringify(first.data).includes(confidential));
  assert.ok(!JSON.stringify(first.data).includes('previous.example.test'));

  await app.call(`${settingsPath}/webhook`, { project_id: repositoryId, object_kind: 'push' }, 200, 'POST', { 'X-Gitlab-Token': legacySecret });
  const before = (await app.call<WorkspaceSnapshot>('/workspace')).data;
  const { data: receipt } = await app.call<GitlabWebhookStatus>(`${settingsPath}/webhook-status`);
  const next = (await app.call<History>(historyPath, { ...input, managementToken })).data;
  assert.deepEqual(next.localReceipt, receipt.repositories[0].lastDelivery);
  assert.equal(next.localReceipt?.authentication, 'secret-token');
  assert.deepEqual(next.attempts, first.data.attempts);
  assert.deepEqual(source.calls.slice(-2).map(call => [call.url.pathname, call.credential]), [[hookPath, managementToken], [historyHookPath, managementToken]]);
  assert.ok(source.calls.every(call => call.method === 'GET' && call.body === undefined));
  assert.deepEqual((await app.call<GitlabSettings>(settingsPath)).data, settings);
  assert.deepEqual((await app.call<WorkspaceSnapshot>('/workspace')).data, before);
});

test('history correlates an authenticated message across retries and keeps HTTP success, repository receipt and message evidence distinct', async t => {
  const message = randomUUID(), unrelated = randomUUID(), eventUuid = randomUUID();
  const conflicting = randomUUID(), proxyOnly = randomUUID();
  const deliveryPath = `${settingsPath}/webhook`;
  const source = await gitlab(t, (call, response) => {
    assert.equal(call.method, 'GET');
    if (call.url.pathname === hookPath) return reply(response, [hook(12)]);
    assert.equal(call.url.pathname, historyHookPath);
    return reply(response, [
      { id: 51, response_status: 200, request_headers: { 'Idempotency-Key': message } },
      { id: 52, response_status: 401, request_headers: { 'webhook-id': message, 'idempotency-key': message } },
      { id: 53, response_status: 200, request_headers: { 'webhook-id': proxyOnly } },
      { id: 54, response_status: 200, request_headers: { 'X-GitLab-Event-UUID': eventUuid } },
      { id: 55, response_status: 200, request_headers: { 'webhook-id': message, 'idempotency-key': conflicting } },
    ].map(row => ({ ...row, url: receiverUrl, trigger: 'push_hooks' })));
  });
  const app = await fixture(t);
  let settings = await app.configure(source.url, { projectIds: [repositoryId, 99], signingToken });
  const history = () => app.call<History>(historyPath, { ...reviewInput(settings), hookId: 12 }).then(({ data }) => data);
  const results = ({ attempts }: History) => attempts.map(row => row.messageReceipt.status);
  const push = { project_id: repositoryId, object_kind: 'push' };
  const secret = { 'X-Gitlab-Token': legacySecret };
  const accepted = ['matched', 'matched', 'unconfirmed', 'unavailable', 'unavailable'];
  const unconfirmed = ['unconfirmed', 'unconfirmed', 'unconfirmed', 'unavailable', 'unavailable'];
  await app.call(deliveryPath, push, 200, 'POST', { ...secret, 'webhook-id': unrelated, 'X-Gitlab-Event-UUID': eventUuid });
  await app.call(deliveryPath, { ...push, project_id: 99 }, 200, 'POST', { ...secret, 'webhook-id': message });
  await app.call(deliveryPath, { ...push, object_kind: 'pipeline' }, 200, 'POST', { ...secret, 'webhook-id': message });
  await app.call(deliveryPath, push, 401, 'POST', { 'X-Gitlab-Token': 'rejected-fixture-token', 'webhook-id': message });
  const first = await history();
  assert.ok(first.localReceipt);
  assert.equal(first.attempts[0].status, 200);
  assert.deepEqual(results(first), unconfirmed);

  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', Buffer.alloc(32, 7))
    .update(`${message}.${timestamp}.${JSON.stringify(push)}`).digest('base64');
  const signed = { 'webhook-id': message, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` };
  await app.call(deliveryPath, push, 200, 'POST', signed);
  const receipt = (await app.call<GitlabWebhookStatus>(`${settingsPath}/webhook-status`)).data.repositories[0].lastDelivery;
  assert.ok(receipt && !receipt.duplicate && receipt.authentication === 'signing-token');

  await app.call(deliveryPath, push, 200, 'POST', signed);
  await app.restart();
  const matched = await history();
  assert.deepEqual(results(matched), accepted);
  assert.deepEqual(matched.attempts.slice(0, 2).map(row => row.messageReceipt), [
    { status: 'matched', delivery: receipt }, { status: 'matched', delivery: receipt },
  ]);
  assert.equal(matched.localReceipt?.duplicate, true);
  assert.equal(matched.attempts[1].status, 401);
  for (const privateValue of [message, unrelated, eventUuid, conflicting, proxyOnly, signature, 'messageDigests', 'request_headers']) {
    assert.ok(!JSON.stringify(matched).includes(privateValue));
  }

  settings = await app.configure(source.url, { projectIds: [repositoryId, 99], signingToken, token: 'rotated-fixture-read-token' });
  assert.deepEqual(results(await history()), accepted, 'read token changes preserve an authenticated receipt');
  settings = await app.configure(source.url, { projectIds: [repositoryId, 99], signingToken, webhookSecret: 'rotated-fixture-receiver-token' });
  assert.deepEqual(results(await history()), unconfirmed);
  await app.call(deliveryPath, push, 200, 'POST', { ...signed, 'Idempotency-Key': proxyOnly });
  assert.deepEqual(results(await history()), unconfirmed, 'a signed ID does not authenticate a different legacy alias');
  await app.call(deliveryPath, push, 200, 'POST', signed);
  assert.deepEqual(results(await history()), accepted);

  const backup = (await app.call('/export')).data;
  await app.call('/import', { confirm: 'REPLACE', data: backup });
  settings = (await app.call<GitlabSettings>(settingsPath)).data;
  assert.deepEqual(results(await history()), unconfirmed);
});

test('delivery history reports access and invalid response errors safely and can retry', async t => {
  const confidential = 'private synthetic GitLab error';
  let responseStatus = 200;
  let malformed = false;
  const source = await gitlab(t, (call, response) => {
    if (call.url.pathname === hookPath) return reply(response, [hook(12)]);
    assert.equal(call.url.pathname, historyHookPath);
    return reply(response, responseStatus !== 200 ? { error: confidential } : malformed ? { malformed: confidential } : [], responseStatus);
  });
  const app = await fixture(t);
  const settings = await app.configure(source.url);
  const input = { ...reviewInput(settings), hookId: 12 };
  for (const [status, expected] of [[401, 401], [403, 403], [404, 404], [429, 429], [500, 502]]) {
    responseStatus = status;
    const { data } = await app.call<{ error: string }>(historyPath, input, expected);
    assert.ok(!JSON.stringify(data).includes(confidential));
    if (status === 404) assert.match(data.error, /권한.*GitLab 버전/);
  }
  responseStatus = 200;
  malformed = true;
  const invalid = await app.call<{ error: string }>(historyPath, input, 502);
  assert.match(invalid.data.error, /응답 형식/);
  assert.ok(!JSON.stringify(invalid.data).includes(confidential));
  malformed = false;
  assert.deepEqual((await app.call<History>(historyPath, input)).data, {
    settingsVersion: settings.version, repositoryId, hookId: 12, attempts: [], partial: false, localReceipt: null,
  });
});

test('delivery history discards reads when the GitLab settings change during hook verification or history loading', async t => {
  let barrier: { path: string; arrived: PromiseWithResolvers<void>; gate: PromiseWithResolvers<void> } | null = null;
  const source = await gitlab(t, async (call, response) => {
    if (barrier?.path === call.url.pathname) {
      barrier.arrived.resolve();
      await barrier.gate.promise;
    }
    if (call.url.pathname === hookPath) return reply(response, [hook(12)]);
    assert.equal(call.url.pathname, historyHookPath);
    return reply(response, []);
  });
  const app = await fixture(t);
  let settings = await app.configure(source.url);
  for (const path of [hookPath, historyHookPath]) {
    barrier = { path, arrived: Promise.withResolvers<void>(), gate: Promise.withResolvers<void>() };
    const first = source.calls.length;
    const pending = app.call(historyPath, { ...reviewInput(settings), hookId: 12 }, 409);
    try {
      await Promise.race([barrier.arrived.promise, pending.then(() => { throw new Error('History returned before the upstream read'); })]);
      settings = await app.configure(source.url);
    } finally { barrier.gate.resolve(); }
    await pending;
    assert.deepEqual(source.calls.slice(first).map(call => call.url.pathname), path === hookPath ? [hookPath] : [hookPath, historyHookPath]);
  }
});

test('closing the browser request cancels an in-flight GitLab delivery history read', { timeout: 5_000 }, async t => {
  const started = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  const source = await gitlab(t, (call, response) => {
    if (call.url.pathname === hookPath) return reply(response, [hook(12)]);
    assert.equal(call.url.pathname, historyHookPath);
    response.once('close', disconnected.resolve);
    started.resolve();
  });
  const app = await fixture(t);
  const settings = await app.configure(source.url);
  const abort = new AbortController();
  const pending = app.call(historyPath, { ...reviewInput(settings), hookId: 12 }, 200, 'POST', {}, abort.signal);
  try {
    await Promise.race([started.promise, pending.then(() => { throw new Error('History returned before the upstream read'); })]);
  } finally { abort.abort(); }
  await assert.rejects(pending, { name: 'AbortError' });
  await disconnected.promise;
  assert.deepEqual((await app.call<GitlabSettings>(settingsPath)).data, settings);
});
