import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { ErrorRequestHandler } from 'express';
import { Store } from '../../server/store.js';
import { seed } from '../../server/seed.js';
import { OUTBOUND_EVENT_TYPES, OutboundWebhookError, OutboundWebhookService } from '../../server/outbound-webhooks.js';
import type { Comment, DocPage, Issue, WebhookDelivery, WebhookEndpointCreated, WebhookEnvelope } from '../../shared/types.js';

type Received = { body: string; headers: IncomingHttpHeaders; response: ServerResponse; path: string };
async function receiver(handler: (message: Received) => void = message => { message.response.writeHead(204).end(); }) {
  const received: Received[] = [], waiters: (() => void)[] = [];
  const server = createServer((request, response) => { const chunks: Buffer[] = []; request.on('data', chunk => chunks.push(Buffer.from(chunk))); request.on('end', () => { const message = { body: Buffer.concat(chunks).toString('utf8'), headers: request.headers, response, path: request.url || '/' }; received.push(message); handler(message); for (const notify of waiters.splice(0)) notify(); }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received,
    async wait(count = 1) { if (received.length >= count) return; await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Synthetic receiver did not receive request')), 3000); const check = () => { if (received.length >= count) { clearTimeout(timer); resolve(); } else waiters.push(check); }; waiters.push(check); }); },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
function fixture(extra: ConstructorParameters<typeof OutboundWebhookService>[1] = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'teamspace-webhook-')), store = new Store(dir); seed(store);
  let clock = Date.now(); const service = new OutboundWebhookService(store, { autoStart: false, now: () => clock, ...extra });
  const context = <T>(action: () => T) => store.withMutationContext({ actorId: 'user-seo', origin: 'user' }, action);
  const endpoint = (url: string, scopes: string[] | null = ['project-neo'], eventTypes = OUTBOUND_EVENT_TYPES) => { const created = service.create({ name: '합성 수신처', url, projectIds: scopes, eventTypes }); const enabled = service.update(created.endpoint.id, { enabled: true }, created.endpoint.version); return { ...created, endpoint: enabled }; };
  return { dir, store, service, context, endpoint, now: () => clock, advance: (ms: number) => { clock += ms; }, setClock: (time: number) => { clock = time; }, close() { service.close(); store.db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
type Fixture = ReturnType<typeof fixture>;
function mutateIssue(f: Fixture, title = '웹훅 변경', extra: Partial<Issue> = {}) { const old = f.store.get<Issue>('issues', 'issue-1')!; f.context(() => f.store.put('issues', { ...old, title, ...extra, version: old.version + 1, updatedAt: new Date(f.now()).toISOString() })); return f.store.get<Issue>('issues', old.id)!; }
async function drain(service: OutboundWebhookService) { for (let i = 0; i < 30; i++) if (!await service.tick()) return; throw new Error('Synthetic outbox did not drain'); }
const deliveries = (f: Fixture) => f.service.listDeliveries({ limit: 100 });

test('outbox capture is atomic with canonical writes and audit failures, suppresses imports and semantic no-ops, and never copies raw content', () => {
  const f = fixture();
  try {
    const created = f.service.create({ name: '기본 비활성', url: 'http://127.0.0.1:1/hook', projectIds: null, eventTypes: OUTBOUND_EVENT_TYPES }); assert.equal(created.endpoint.enabled, false);
    mutateIssue(f, '비활성 때 변경'); assert.equal(deliveries(f).length, 0);
    f.service.update(created.endpoint.id, { enabled: true }, 1);
    const before = f.store.get<Issue>('issues', 'issue-1')!;
    assert.throws(() => f.store.transaction(() => { mutateIssue(f, '감사 실패로 취소'); throw new Error('audit failed'); }), /audit failed/); assert.deepEqual(f.store.get('issues', before.id), before); assert.equal(deliveries(f).length, 0);
    const unsubscribe = f.store.onChange(() => { throw new Error('later listener failed'); }, ['issues']);
    assert.throws(() => mutateIssue(f, '리스너 실패로 취소'), /later listener/); unsubscribe(); assert.deepEqual(f.store.get('issues', before.id), before); assert.equal(f.store.all('webhook_events').length, 0);
    f.context(() => f.store.put('issues', { ...before, customFields: {}, version: before.version + 1, updatedAt: '2030-01-01T00:00:00.000Z' })); assert.equal(deliveries(f).length, 0);
    const last = f.store.get<Issue>('issues', before.id)!; const count = deliveries(f).length;
    f.store.withMutationContext({ actorId: 'user-min', origin: 'import' }, () => f.store.put('issues', { ...last, title: '가져오기 변경', version: last.version + 1 })); assert.equal(deliveries(f).length, count);
    const secretText = 'RAW_BODY_PASSWORD_AND_TOKEN_NEVER_SEND';
    f.store.withMutationContext({ actorId: 'user-yun', origin: 'automation', sourceEventId: 'gitlab-event-123' }, () => { const old = f.store.get<Issue>('issues', before.id)!; f.store.put('issues', { ...old, title: '자동화 상태 변경', description: secretText, customFields: { token: secretText }, status: 'review', version: old.version + 1 }); });
    const detail = f.service.deliveryDetail(deliveries(f)[0].id); assert.equal(detail.envelope.origin, 'automation'); assert.equal(detail.envelope.actorId, 'user-yun'); assert.equal(detail.envelope.sourceEventId, 'gitlab-event-123'); assert.ok(detail.envelope.changedFields.includes('customFields')); assert.ok(detail.envelope.changedFields.includes('description')); assert.equal(JSON.stringify(detail).includes(secretText), false); assert.equal(detail.envelope.resource.title, '자동화 상태 변경');
    const endpointsBefore = f.service.listEndpoints(); assert.throws(() => f.service.create({ name: '실패 설정', url: 'http://localhost:1/', projectIds: null, eventTypes: ['issue.created'] }, () => { throw new Error('audit failed'); }), /audit failed/); assert.deepEqual(f.service.listEndpoints(), endpointsBefore);
    assert.throws(() => f.service.update(created.endpoint.id, { url: 'http://localhost:2/' }, 2, () => { throw new Error('audit failed'); }), /audit failed/); assert.deepEqual(f.service.listEndpoints(), endpointsBefore);
  } finally { f.close(); }
});

test('all seven event types use real parent project scope and one immutable event ID fans out to matching destinations', () => {
  const f = fixture();
  try {
    const all = f.endpoint('http://localhost:1/all', null), neo = f.endpoint('http://localhost:1/neo', ['project-neo']);
    const issue = { ...f.store.get<Issue>('issues', 'issue-1')!, id: 'outbound-issue', key: 'NEO-999', title: '생성 업무', version: 1 };
    const document = { ...f.store.get<DocPage>('documents', 'doc-overview')!, id: 'outbound-doc', projectId: null, parentId: null, title: '공통 문서', version: 1 };
    const comment: Comment = { id: 'outbound-comment', resourceType: 'document', resourceId: document.id, authorId: 'user-jun', body: 'PRIVATE COMMENT BODY', createdAt: new Date(f.now()).toISOString() };
    f.context(() => { f.store.put('issues', issue); f.store.put('issues', { ...issue, title: '변경 업무', version: 2 }); f.store.remove('issues', issue.id); f.store.put('documents', document); f.store.put('documents', { ...document, title: '변경 공통 문서', version: 2 }); f.store.put('comments', comment); f.store.put('comments', { ...comment, body: 'PRIVATE UPDATED COMMENT' }); f.store.remove('comments', comment.id); f.store.remove('documents', document.id); });
    const rows = deliveries(f), types = new Set(rows.map(row => row.eventType)); assert.deepEqual([...types].sort(), [...OUTBOUND_EVENT_TYPES].sort()); assert.equal(rows.filter(row => row.endpointId === all.endpoint.id).length, 7); assert.equal(rows.filter(row => row.endpointId === neo.endpoint.id).length, 3);
    const created = rows.filter(row => row.eventType === 'issue.created'); assert.equal(created.length, 2); assert.equal(created[0].eventId, created[1].eventId);
    const createdComment = f.service.deliveryDetail(rows.find(row => row.eventType === 'comment.created')!.id).envelope; assert.equal(createdComment.projectId, null); assert.equal(createdComment.resource.parentId, document.id); assert.equal(createdComment.resource.parentType, 'document'); assert.equal(JSON.stringify(createdComment).includes('PRIVATE'), false);
    assert.equal(f.store.all('webhook_events').length, 7);
  } finally { f.close(); }
});

test('actual HTTP attempts sign exact bytes, keep stable IDs across backoff, cap failures, and support CAS manual retry', async () => {
  let failRequests = true; const target = await receiver(message => { message.response.writeHead(failRequests ? 503 : 204).end(failRequests ? 'PRIVATE RECEIVER ERROR TOKEN' : ''); }); const f = fixture({ retryBaseMs: 1000, maxAttempts: 3 });
  try {
    const endpoint = f.endpoint(target.url); mutateIssue(f, '한글 서명과 정확한 본문'); const initial = deliveries(f)[0];
    assert.equal(await f.service.tick(), 1); let current = deliveries(f)[0]; assert.equal(current.status, 'pending'); assert.equal(current.attempts, 1); assert.equal(current.httpStatus, 503); assert.equal(current.lastError?.includes('PRIVATE'), false); assert.ok(current.nextAttemptAt); assert.equal(await f.service.tick(), 0);
    f.setClock(Date.parse(current.nextAttemptAt!)); await f.service.tick(); current = deliveries(f)[0]; assert.equal(current.attempts, 2); assert.equal(Date.parse(current.nextAttemptAt!) - f.now(), 2000);
    f.setClock(Date.parse(current.nextAttemptAt!)); await f.service.tick(); current = deliveries(f)[0]; assert.equal(current.status, 'failed'); assert.equal(current.attempts, 3); assert.equal(current.nextAttemptAt, null);
    for (const message of target.received) { const id = message.headers['webhook-id'], timestamp = message.headers['webhook-timestamp']; assert.equal(id, initial.eventId); assert.equal(message.body, target.received[0].body); const signature = createHmac('sha256', Buffer.from(endpoint.secret.slice(6), 'base64')).update(`${id}.${timestamp}.${message.body}`).digest('base64'); assert.equal(message.headers['webhook-signature'], `v1,${signature}`); assert.equal(message.headers['content-type'], 'application/json'); }
    assert.throws(() => f.service.retry(current.id, current.version - 1), (error: unknown) => error instanceof OutboundWebhookError && error.status === 409);
    failRequests = false; const retried = f.service.retry(current.id, current.version); assert.equal(retried.attempts, 0); assert.equal(retried.eventId, initial.eventId); await f.service.tick(); const succeeded = deliveries(f)[0]; assert.equal(succeeded.status, 'succeeded'); assert.equal(succeeded.attempts, 1); assert.equal(target.received.at(-1)!.headers['webhook-id'], initial.eventId); assert.throws(() => f.service.retry(succeeded.id, succeeded.version), /실패하거나 취소/);
    assert.equal(JSON.stringify(f.service.deliveryDetail(succeeded.id)).includes(endpoint.secret), false); assert.equal(JSON.stringify(f.service.listEndpoints()).includes(endpoint.secret), false);
    const stored = f.store.db.prepare('SELECT secret,json FROM webhook_endpoints').get() as { secret: string; json: string }; assert.equal(stored.secret.includes(endpoint.secret), false); assert.equal(f.store.unseal(stored.secret), endpoint.secret);
  } finally { f.close(); await target.close(); }
});

test('the worker refuses redirects, bounds receiver bodies, times out, and never stores receiver content or destination error URLs', async () => {
  const redirected = await receiver(); const target = await receiver(message => {
    if (message.path === '/redirect') message.response.writeHead(302, { Location: redirected.url }).end('secret redirect body');
    else if (message.path === '/large') message.response.writeHead(200).end(Buffer.alloc(2 * 1024 * 1024, 'x'));
    // /hang intentionally sends no response headers.
  }); const f = fixture({ timeoutMs: 60, maxAttempts: 1 });
  try {
    const endpoint = f.endpoint(target.url + '/redirect'); mutateIssue(f); await f.service.tick(); assert.equal(deliveries(f)[0].status, 'failed'); assert.equal(deliveries(f)[0].httpStatus, 302); assert.equal(redirected.received.length, 0);
    const current = f.service.update(endpoint.endpoint.id, { url: target.url + '/large' }, 2); mutateIssue(f, '큰 응답은 읽지 않음'); await f.service.tick(); assert.equal(deliveries(f)[0].status, 'succeeded'); assert.ok(JSON.stringify(f.service.deliveryDetail(deliveries(f)[0].id)).length < 5000);
    f.service.update(current.id, { url: target.url + '/hang?private=SECRET_QUERY' }, current.version); mutateIssue(f, '시간 제한'); await f.service.tick(); const timed = deliveries(f)[0]; assert.equal(timed.status, 'failed'); assert.equal(timed.httpStatus, null); assert.match(timed.lastError!, /시간 제한/); assert.equal(timed.lastError!.includes(target.url), false); assert.equal(timed.lastError!.includes('SECRET_QUERY'), false);
  } finally { f.close(); await target.close(); await redirected.close(); }
});

test('settings CAS changes cancel queued and inflight completions; retry uses current scope, secret and endpoint version', async () => {
  const target = await receiver(() => {}), f = fixture();
  try {
    const created = f.endpoint(target.url); mutateIssue(f, '전송 중 교체'); const sending = f.service.tick(); await target.wait(); const inflight = deliveries(f)[0]; assert.equal(inflight.status, 'delivering');
    const rotated = f.service.rotateSecret(created.endpoint.id, 2); assert.notEqual(rotated.secret, created.secret); assert.equal(deliveries(f)[0].status, 'cancelled'); target.received[0].response.writeHead(200).end(); await sending; assert.equal(deliveries(f)[0].status, 'cancelled');
    let old = deliveries(f)[0]; const outside = f.service.update(rotated.endpoint.id, { projectIds: ['project-team'] }, rotated.endpoint.version); assert.throws(() => f.service.retry(old.id, old.version), (error: unknown) => error instanceof OutboundWebhookError && error.status === 422);
    const restored = f.service.update(outside.id, { projectIds: ['project-neo'] }, outside.version); old = deliveries(f)[0]; const retry = f.service.retry(old.id, old.version); assert.equal(retry.status, 'pending'); const second = f.service.tick(); await target.wait(2); target.received[1].response.writeHead(204).end(); await second;
    const wire = target.received[1], signature = createHmac('sha256', Buffer.from(rotated.secret.slice(6), 'base64')).update(`${wire.headers['webhook-id']}.${wire.headers['webhook-timestamp']}.${wire.body}`).digest('base64'); assert.equal(wire.headers['webhook-signature'], `v1,${signature}`); assert.equal(deliveries(f)[0].status, 'succeeded');
    mutateIssue(f, '비활성 직전 대기'); const disabled = f.service.update(restored.id, { enabled: false }, restored.version); assert.equal(deliveries(f)[0].status, 'cancelled'); assert.equal(await f.service.tick(), 0); assert.throws(() => f.service.retry(deliveries(f)[0].id, deliveries(f)[0].version), /현재 활성화/);
    f.service.remove(disabled.id, disabled.version); assert.equal(f.service.listEndpoints().length, 0); assert.equal(f.service.deliveryDetail(inflight.id).delivery.status, 'succeeded');
  } finally { f.close(); await target.close(); }
});

test('durable pending deliveries survive reopen and two workers cannot share an active lease; expired lease rejects stale completion', async () => {
  const target = await receiver(() => {}), f = fixture({ leaseMs: 11000 }); let secondStore: Store | undefined, second: OutboundWebhookService | undefined;
  try {
    f.endpoint(target.url); mutateIssue(f); const pending = deliveries(f)[0];
    secondStore = new Store(f.dir); second = new OutboundWebhookService(secondStore, { autoStart: false, now: f.now, leaseMs: 11000 });
    const firstSend = f.service.tick(); await target.wait(); assert.equal(await second.tick(), 0); assert.equal(target.received.length, 1);
    f.advance(12000); const recovered = second.tick(); await target.wait(2); assert.equal(target.received[1].headers['webhook-id'], pending.eventId); target.received[1].response.writeHead(204).end(); await recovered; const after = f.service.deliveryDetail(pending.id).delivery; assert.equal(after.status, 'succeeded'); assert.equal(after.attempts, 2);
    target.received[0].response.writeHead(503).end('stale failure'); await firstSend; assert.deepEqual(f.service.deliveryDetail(pending.id).delivery, after);
    mutateIssue(f, '재시작 뒤 전송할 대기'); const queued = deliveries(f)[0]; second.close(); secondStore.db.close(); second = undefined; secondStore = undefined; f.service.close();
    secondStore = new Store(f.dir); second = new OutboundWebhookService(secondStore, { autoStart: false, now: f.now }); const restartSend = second.tick(); await target.wait(3); target.received[2].response.writeHead(204).end(); await restartSend; assert.equal(second.deliveryDetail(queued.id).delivery.status, 'succeeded');
  } finally { second?.close(); secondStore?.db.close(); f.close(); await target.close(); }
});

test('import generation reset rolls back atomically and committed reset prevents old inflight callbacks from resurrecting records', async () => {
  const target = await receiver(() => {}), f = fixture();
  try {
    f.endpoint(target.url); mutateIssue(f); const first = f.service.tick(); await target.wait(); const old = deliveries(f)[0];
    assert.throws(() => f.store.transaction(() => { f.service.resetForImport(); throw new Error('late import validation failed'); }), /late import/); assert.equal(f.service.listEndpoints().length, 1); assert.equal(deliveries(f)[0].id, old.id);
    target.received[0].response.writeHead(204).end(); await first; assert.equal(deliveries(f)[0].status, 'succeeded');
    mutateIssue(f, '가져오기로 사라질 전송'); const inflight = f.service.tick(); await target.wait(2); f.store.transaction(() => f.service.resetForImport()); assert.equal(f.service.listEndpoints().length, 0); assert.equal(deliveries(f).length, 0); target.received[1].response.writeHead(200).end(); await inflight; assert.equal(f.store.all('webhook_events').length, 0); assert.equal(f.store.all('webhook_deliveries').length, 0); assert.equal(await f.service.tick(), 0);
  } finally { f.close(); await target.close(); }
});

test('close aborts and releases owned leases before database close, and retention removes only terminal old history', async () => {
  const target = await receiver(() => {}), f = fixture();
  try {
    f.endpoint(target.url); mutateIssue(f); const sending = f.service.tick(); await target.wait(); const old = deliveries(f)[0]; f.service.close(); const row = f.store.get<WebhookDelivery>('webhook_deliveries', old.id)!; assert.equal(row.status, 'pending'); assert.equal(row.attempts, 1); f.store.db.close(); await sending;
    const reopened = new Store(f.dir), worker = new OutboundWebhookService(reopened, { autoStart: false, now: f.now }); try { const resending = worker.tick(); await target.wait(2); target.received[1].response.writeHead(204).end(); await resending; f.advance(31 * 86400000); await worker.tick(); assert.equal(worker.listDeliveries().length, 0); assert.equal(reopened.all('webhook_events').length, 0); } finally { worker.close(); reopened.db.close(); }
  } finally { f.service.close(); rmSync(f.dir, { recursive: true, force: true }); await target.close(); }
});

test('management HTTP routes validate URL/scope/event bounds, expose secrets once, and protect scalar queries and CAS', async () => {
  const f = fixture(), app = express(); app.use(express.json()); f.service.registerRoutes(app, { actor: () => 'user-min', activity: (_request, type, id, action, detail) => f.store.put('activities', { id: `audit-${Math.random()}`, actorId: 'user-min', resourceType: type, resourceId: id, action, detail, createdAt: new Date().toISOString() }) });
  const errors: ErrorRequestHandler = (error, _request, response, next) => { if (response.headersSent) { next(error); return; } response.status(error instanceof OutboundWebhookError ? error.status : 500).json({ error: error instanceof Error ? error.message : 'failed' }); }; app.use(errors);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async <T = unknown>(path: string, method = 'GET', data?: unknown) => { const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }); return { status: response.status, data: await response.json() as T }; };
  try {
    const input = { name: 'HTTP 설정', url: 'http://127.0.0.1:1/', projectIds: null, eventTypes: ['issue.updated'] };
    for (const bad of [{ url: 'ftp://localhost/' }, { url: 'http://user:pass@localhost/' }, { url: 'http://localhost/#fragment' }, { url: 'http://localhost/#' }, { url: 'not a URL' }, { projectIds: [] }, { projectIds: ['missing'] }, { eventTypes: [] }, { eventTypes: ['unknown'] }, { eventTypes: ['issue.updated', 'issue.updated'] }, { enabled: true }]) assert.equal((await call('/webhook-endpoints', 'POST', { ...input, ...bad })).status, 400);
    const made = await call<WebhookEndpointCreated>('/webhook-endpoints', 'POST', input); assert.equal(made.status, 201); assert.match(made.data.secret, /^whsec_[A-Za-z0-9+/]{43}=$/); assert.equal(made.data.endpoint.enabled, false); assert.equal(JSON.stringify((await call('/webhook-endpoints')).data).includes(made.data.secret), false);
    assert.equal((await call(`/webhook-endpoints/${made.data.endpoint.id}`, 'PATCH', { expectedVersion: 7, enabled: true })).status, 409); assert.equal((await call(`/webhook-endpoints/${made.data.endpoint.id}`, 'PATCH', { expectedVersion: 1, enabled: true })).status, 200);
    mutateIssue(f); const delivery = deliveries(f)[0]; const detail = await call<{ delivery: WebhookDelivery; envelope: WebhookEnvelope }>(`/webhook-deliveries/${delivery.id}`); assert.equal(detail.status, 200); assert.equal(detail.data.envelope.id, delivery.eventId);
    for (const path of ['/webhook-deliveries?limit=0', '/webhook-deliveries?limit=101', '/webhook-deliveries?limit=NaN', '/webhook-deliveries?limit=1&limit=2', '/webhook-deliveries?endpointId=a&endpointId=b', '/webhook-deliveries?limit[]=2']) assert.equal((await call(path)).status, 400);
    assert.equal((await call(`/webhook-endpoints/${made.data.endpoint.id}?expectedVersion=NaN`, 'DELETE')).status, 400); assert.equal((await call(`/webhook-endpoints/${made.data.endpoint.id}/rotate-secret`, 'POST', { expectedVersion: 1 })).status, 409);
    for (let i = 1; i <20; i++) f.service.create({ ...input, name: `수신처 ${i}` }); assert.equal((await call('/webhook-endpoints', 'POST', input)).status, 409);
    assert.equal((await call(`/webhook-endpoints/${made.data.endpoint.id}?expectedVersion=2`, 'DELETE')).status, 200); assert.equal(f.service.deliveryDetail(delivery.id).delivery.status, 'cancelled');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); f.close(); }
});

test('automatic unref worker progresses through multiple batches without a manual trigger', async () => {
  const target = await receiver(), f = fixture({ autoStart: true, pollIntervalMs: 15 });
  try { f.endpoint(target.url); for (let index = 0; index < 7; index++) mutateIssue(f, `자동 작업 ${index}`); await target.wait(7); await drain(f.service); assert.equal(deliveries(f).length, 7); assert.ok(deliveries(f).every(delivery => delivery.status === 'succeeded')); assert.equal(new Set(target.received.map(message => message.headers['webhook-id'])).size, 7); }
  finally { f.close(); await target.close(); }
});

test('shutdown on the final allowed attempt cannot create a sixth automatic delivery after restart', async () => {
  const target = await receiver(() => {}), f = fixture({ maxAttempts: 1 });
  try { f.endpoint(target.url); mutateIssue(f); const pending = f.service.tick(); await target.wait(); f.service.close(); await pending; const old = f.store.all<WebhookDelivery>('webhook_deliveries')[0]; assert.equal(old.status, 'failed'); assert.equal(old.attempts, 1); const restarted = new OutboundWebhookService(f.store, { autoStart: false, maxAttempts: 1, now: f.now }); try { assert.equal(await restarted.tick(), 0); assert.equal(target.received.length, 1); assert.equal(restarted.deliveryDetail(old.id).delivery.status, 'failed'); } finally { restarted.close(); } }
  finally { f.close(); await target.close(); }
});
