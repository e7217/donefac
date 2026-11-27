import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { createApp } from '../../server/app.js';
import { Store } from '../../server/store.js';
import { COLLABORATION_SCHEMA, type CollaborationServerMessage, type CollaborationSession } from '../../shared/collaboration.js';
import type { DocPage, DocRevision, RichContent, WebhookDelivery, WebhookEndpointCreated, WebhookEnvelope } from '../../shared/types.js';

const content = (text: string): RichContent => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'donefac-outbound-collaboration-')), service = createApp({ dataDir: dir, outboundWorker: false });
  service.app.post('/synthetic-outbound', (_request, response) => response.status(204).end());
  const server = service.app.listen(0, '127.0.0.1'); service.attachWebSocket(server); await once(server, 'listening'); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, observer = new Store(dir);
  const call = async <T = unknown>(path: string, method = 'GET', body?: unknown, actor = 'user-min') => { const response = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actor }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json() as T }; };
  const endpoint = await call<WebhookEndpointCreated>('/webhook-endpoints', 'POST', { name: '공동 편집 합성 알림', url: base + '/synthetic-outbound', projectIds: ['project-neo'], eventTypes: ['document.created', 'document.updated', 'document.deleted'] }); assert.equal(endpoint.status, 201); assert.equal((await call(`/webhook-endpoints/${endpoint.data.endpoint.id}`, 'PATCH', { expectedVersion: endpoint.data.endpoint.version, enabled: true })).status, 200);
  return { base, observer, call,
    async rows() { return (await call<WebhookDelivery[]>('/webhook-deliveries?limit=100')).data; },
    async events() { return await Promise.all((await this.rows()).map(async delivery => (await call<{ delivery: WebhookDelivery; envelope: WebhookEnvelope }>(`/webhook-deliveries/${delivery.id}`)).data.envelope)); },
    async make() { const response = await call<DocPage>('/documents', 'POST', { projectId: 'project-neo', title: `공동 편집 outbox ${randomUUID()}`, content: content('원본') }); assert.equal(response.status, 201); return response.data; },
    async enable(page: DocPage) { const response = await call<CollaborationSession>(`/documents/${page.id}/collaboration/enable`, 'POST', { expectedVersion: page.version }); assert.equal(response.status, 200); return response.data; },
    async close() { service.close(); await new Promise<void>(resolve => server.close(() => resolve())); observer.db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
class Peer {
  readonly socket: WebSocket; readonly doc = new Y.Doc(); readonly closed: Promise<number>;
  private messages: CollaborationServerMessage[] = [];
  private waiters: { match: (message: CollaborationServerMessage) => boolean; resolve: (message: CollaborationServerMessage) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  constructor(url: string) { this.socket = new WebSocket(url); this.socket.on('error', () => {}); this.closed = new Promise(resolve => this.socket.once('close', resolve)); this.socket.on('message', raw => { const message = JSON.parse(raw.toString()) as CollaborationServerMessage, index = this.waiters.findIndex(waiter => waiter.match(message)); if (index < 0) this.messages.push(message); else { const waiter = this.waiters.splice(index, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(message); } }); }
  send(message: unknown) { this.socket.send(JSON.stringify(message)); }
  next<T extends CollaborationServerMessage['type']>(type: T, requestId?: string): Promise<Extract<CollaborationServerMessage, { type: T }>> {
    const match = (message: CollaborationServerMessage) => message.type === type && (requestId === undefined || 'requestId' in message && message.requestId === requestId), index = this.messages.findIndex(match);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0] as Extract<CollaborationServerMessage, { type: T }>);
    return new Promise((resolve, reject) => { const waiter = { match, resolve: (message: CollaborationServerMessage) => resolve(message as Extract<CollaborationServerMessage, { type: T }>), timer: setTimeout(() => { this.waiters = this.waiters.filter(value => value !== waiter); reject(new Error(`Synthetic websocket did not receive ${type}`)); }, 3000) }; this.waiters.push(waiter); });
  }
  dispose() { this.socket.terminate(); this.doc.destroy(); for (const waiter of this.waiters) clearTimeout(waiter.timer); this.waiters = []; }
}
async function connect(f: Fixture, session: CollaborationSession, actor: string) {
  const peer = new Peer(`${f.base.replace('http:', 'ws:')}/api/collaboration?${new URLSearchParams({ documentId: session.document.id, actorId: actor })}`); await once(peer.socket, 'open'); peer.send({ type: 'hello', epoch: session.epoch, schemaVersion: COLLABORATION_SCHEMA, stateVector: Buffer.from(Y.encodeStateVector(peer.doc)).toString('base64') }); const welcome = await peer.next('welcome'); Y.applyUpdate(peer.doc, Buffer.from(welcome.update, 'base64')); return peer;
}
function insert(peer: Peer, text: string) { const vector = Y.encodeStateVector(peer.doc); ((peer.doc.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, text); return Y.encodeStateAsUpdate(peer.doc, vector); }
async function update(peer: Peer, epoch: string, bytes: Uint8Array, requestId = randomUUID()) { peer.send({ type: 'update', epoch, requestId, update: Buffer.from(bytes).toString('base64') }); return await peer.next('ack', requestId); }

test('manual document writes emit one semantic event despite collaboration snapshot writes, with REST actor attribution', async () => {
  const f = await fixture(); try {
    const page = await f.make(); assert.equal((await f.rows()).length, 1); const session = await f.enable(page); assert.equal((await f.rows()).length, 1);
    const body = await f.call<DocPage>(`/documents/${page.id}`, 'PATCH', { expectedVersion: session.document.version, title: '수동 편집 제목', content: content('PRIVATE DOCUMENT BODY') }, 'user-seo'); assert.equal(body.status, 200); let events = await f.events(); assert.equal(events.length, 2); assert.equal(events[0].actorId, 'user-seo'); assert.equal(events[0].origin, 'user'); assert.deepEqual(events[0].changedFields.sort(), ['content', 'title']); assert.equal(events[0].resource.version, body.data.version); assert.equal(JSON.stringify(events).includes('PRIVATE DOCUMENT BODY'), false);
    const metadata = await f.call<DocPage>(`/documents/${page.id}`, 'PATCH', { expectedVersion: body.data.version, title: '새 속성 제목' }, 'user-jun'); assert.equal(metadata.status, 200); events = await f.events(); assert.equal(events.length, 3); assert.deepEqual(events[0].changedFields, ['title']); assert.equal(events[0].actorId, 'user-jun');
    const noop = await f.call<DocPage>(`/documents/${page.id}`, 'PATCH', { expectedVersion: metadata.data.version, title: metadata.data.title }); assert.equal(noop.status, 200); assert.equal((await f.rows()).length, 3);
  } finally { await f.close(); }
});

test('real WebSocket updates use each peer actor/user origin, suppress duplicate and invalid edits, and do not leak context to REST', async () => {
  const f = await fixture(), peers: Peer[] = []; try {
    const page = await f.make(), session = await f.enable(page), a = await connect(f, session, 'user-seo'), b = await connect(f, session, 'user-yun'); peers.push(a, b);
    const first = await update(a, session.epoch!, insert(a, 'PRIVATE_LIVE_BODY')); assert.equal(first.document.plainText, 'PRIVATE_LIVE_BODY원본'); let events = await f.events(); assert.equal(events.length, 2); assert.equal(events[0].actorId, 'user-seo'); assert.equal(events[0].origin, 'user'); assert.deepEqual(events[0].changedFields, ['content']); assert.equal(JSON.stringify(events).includes('PRIVATE_LIVE_BODY'), false);
    const remote = await b.next('update'); Y.applyUpdate(b.doc, Buffer.from(remote.update, 'base64')); const bytes = insert(b, '두 번째 팀원'), id = randomUUID(), second = await update(b, session.epoch!, bytes, id); events = await f.events(); assert.equal(events.length, 3); assert.equal(events[0].actorId, 'user-yun'); assert.equal(events[0].resource.version, second.document.version);
    assert.equal((await update(b, session.epoch!, bytes, id)).document.version, second.document.version); assert.equal((await update(b, session.epoch!, new Uint8Array([0, 0]))).document.version, second.document.version); assert.equal((await f.rows()).length, 3);
    assert.equal((await f.call(`/documents/${page.id}/checkpoint`, 'POST', {}, 'user-jun')).status, 200); assert.equal((await f.rows()).length, 3);
    const bad = new Y.Doc(); Y.applyUpdate(bad, Y.encodeStateAsUpdate(b.doc)); bad.getXmlFragment('default').push([new Y.XmlElement('unsupportedWidget')]); b.send({ type: 'update', epoch: session.epoch, requestId: randomUUID(), update: Buffer.from(Y.encodeStateAsUpdate(bad, Y.encodeStateVector(b.doc))).toString('base64') }); bad.destroy(); assert.equal((await b.next('error')).code, 'INVALID_SCHEMA'); assert.equal((await f.rows()).length, 3);
    const rest = await f.call<DocPage>(`/documents/${page.id}`, 'PATCH', { expectedVersion: second.document.version, title: 'REST 요청의 독립 작업자' }, 'user-min'); assert.equal(rest.status, 200); events = await f.events(); assert.equal(events.length, 4); assert.equal(events[0].actorId, 'user-min'); assert.equal(events[0].origin, 'user'); assert.equal(events[0].sourceEventId, null);
  } finally { peers.forEach(peer => peer.dispose()); await f.close(); }
});

test('restore emits exactly one event and epoch reset only after commit; stale and late failed restores preserve document/Yjs/outbox', async () => {
  const f = await fixture(); let peer: Peer | undefined; try {
    const page = await f.make(), session = await f.enable(page); peer = await connect(f, session, 'user-seo'); const initial = (await f.call<DocRevision[]>(`/documents/${page.id}/revisions`)).data[0], edited = await update(peer, session.epoch!, insert(peer, '수정된 '));
    const before = { page: f.observer.get<DocPage>('documents', page.id), deliveries: await f.rows(), revisions: (await f.call<DocRevision[]>(`/documents/${page.id}/revisions`)).data, state: f.observer.db.prepare('SELECT epoch,state FROM collaboration_documents WHERE document_id=?').get(page.id) };
    assert.equal((await f.call(`/documents/${page.id}/restore`, 'POST', { revisionId: initial.id, expectedVersion: edited.document.version - 1 })).status, 409); assert.deepEqual(await f.rows(), before.deliveries);
    f.observer.db.exec("CREATE TRIGGER synthetic_restore_audit_failure BEFORE INSERT ON activities WHEN json_extract(NEW.json,'$.action')='문서 복구' BEGIN SELECT RAISE(ABORT,'synthetic restore rollback'); END");
    const failed = await f.call(`/documents/${page.id}/restore`, 'POST', { revisionId: initial.id, expectedVersion: edited.document.version }, 'user-yun'); assert.equal(failed.status, 500); assert.deepEqual(f.observer.get('documents', page.id), before.page); assert.deepEqual(await f.rows(), before.deliveries); assert.deepEqual((await f.call<DocRevision[]>(`/documents/${page.id}/revisions`)).data, before.revisions); assert.deepEqual(f.observer.db.prepare('SELECT epoch,state FROM collaboration_documents WHERE document_id=?').get(page.id), before.state); peer.send({ type: 'ping' }); assert.equal((await peer.next('pong')).type, 'pong');
    f.observer.db.exec('DROP TRIGGER synthetic_restore_audit_failure');
    const restored = await f.call<DocPage>(`/documents/${page.id}/restore`, 'POST', { revisionId: initial.id, expectedVersion: edited.document.version }, 'user-yun'); assert.equal(restored.status, 200); assert.equal(restored.data.plainText, '원본'); const rows = await f.rows(); assert.equal(rows.length, before.deliveries.length + 1); const event = (await f.events())[0]; assert.equal(event.actorId, 'user-yun'); assert.equal(event.origin, 'user'); assert.equal(event.type, 'document.updated'); assert.deepEqual(event.changedFields, ['content']); assert.equal(event.resource.version, restored.data.version); assert.equal(event.previous?.version, edited.document.version); const reset = await peer.next('reset'); assert.notEqual(reset.epoch, session.epoch); assert.equal(await peer.closed, 4409);
  } finally { peer?.dispose(); await f.close(); }
});
