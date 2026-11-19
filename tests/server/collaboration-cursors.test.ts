import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as realTimeout } from 'node:timers';
import test, { type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { createApp } from '../../server/app.js';
import {
  COLLABORATION_CURSOR_PROTOCOL, COLLABORATION_SCHEMA, MAX_COLLABORATION_CURSOR_BYTES,
  type CollaborationCursorSelection, type CollaborationServerMessage, type CollaborationSession,
} from '../../shared/collaboration.js';
import type { DocPage, RichContent } from '../../shared/types.js';

type MessageType = CollaborationServerMessage['type'];
type Message<T extends MessageType> = Extract<CollaborationServerMessage, { type: T }>;
const content = (text: string): RichContent => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

class CursorSocket {
  readonly socket: WebSocket;
  readonly closed: Promise<number>;
  readonly doc = new Y.Doc();
  private readonly messages: CollaborationServerMessage[] = [];
  private readonly wake = new Set<() => void>();

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on('error', () => {});
    this.closed = new Promise(resolve => this.socket.once('close', resolve));
    this.socket.on('message', raw => {
      this.messages.push(JSON.parse(raw.toString()) as CollaborationServerMessage);
      for (const notify of this.wake) notify();
    });
  }

  send(value: unknown): void { this.socket.send(JSON.stringify(value)); }

  next<T extends MessageType>(type: T): Promise<Message<T>> {
    return new Promise((resolve, reject) => {
      const timer = realTimeout(() => {
        this.wake.delete(testMessages);
        reject(new Error(`Expected ${type}; saw ${this.messages.map(message => message.type).join(',')}`));
      }, 5_000).unref();
      const testMessages = () => {
        const index = this.messages.findIndex(message => message.type === type);
        if (index < 0) return;
        clearTimeout(timer);
        this.wake.delete(testMessages);
        resolve(this.messages.splice(index, 1)[0] as Message<T>);
      };
      this.wake.add(testMessages);
      testMessages();
    });
  }

  async barrier(): Promise<void> {
    this.send({ type: 'ping' });
    await this.next('pong');
  }

  noCursor(): void { assert.ok(this.messages.every(message => message.type !== 'cursor')); }

  get text(): Y.XmlText { return (this.doc.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText; }

  selection(anchor = 0, head = anchor): CollaborationCursorSelection {
    const position = (index: number) => encode(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(this.text, index)));
    return { anchor: position(anchor), head: position(head) };
  }
}

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-collaboration-cursors-'));
  const service = createApp({ dataDir, outboundWorker: false });
  const server = service.app.listen(0, '127.0.0.1');
  service.attachWebSocket(server);
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  const clients = new Set<CursorSocket>();
  t.after(async () => {
    for (const client of clients) {
      client.socket.terminate();
      client.doc.destroy();
    }
    service.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function request<T>(path: string, method = 'GET', body?: unknown, expected = 200): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': 'user-min' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result as T;
  }

  async function make(title: string) {
    const doc = await request<DocPage>('/documents', 'POST', { projectId: 'project-neo', title, content: content('협업 원본') }, 201);
    return request<CollaborationSession>(`/documents/${doc.id}/collaboration/enable`, 'POST', { expectedVersion: doc.version });
  }

  async function open(session: CollaborationSession, actorId: string) {
    const client = new CursorSocket(`ws://127.0.0.1:${port}/api/collaboration?${new URLSearchParams({ documentId: session.document.id, actorId })}`);
    clients.add(client);
    await once(client.socket, 'open');
    return client;
  }

  async function hello(client: CursorSocket, session: CollaborationSession, cursors = true) {
    client.send({
      type: 'hello', epoch: session.epoch, schemaVersion: COLLABORATION_SCHEMA,
      stateVector: encode(Y.encodeStateVector(client.doc)), ...(cursors && { cursorProtocol: COLLABORATION_CURSOR_PROTOCOL }),
    });
    const welcome = await client.next('welcome');
    Y.applyUpdate(client.doc, Buffer.from(welcome.update, 'base64'));
    return welcome;
  }

  async function connect(session: CollaborationSession, actorId: string, cursors = true) {
    const client = await open(session, actorId);
    const welcome = await hello(client, session, cursors);
    return { client, welcome };
  }

  return { request, make, open, hello, connect };
}

test('cursor negotiation scopes identity and snapshots to the ready document and epoch', async t => {
  const f = await fixture(t);
  const first = await f.make('목표 문서'), second = await f.make('별도 문서');
  const sender = await f.connect(first, 'user-min');
  const receiver = await f.connect(first, 'user-seo');
  const legacy = await f.connect(first, 'user-jun', false);
  const otherRoom = await f.connect(second, 'user-seo');
  const pending = await f.open(first, 'user-jun');
  assert.equal(sender.welcome.cursorProtocol, COLLABORATION_CURSOR_PROTOCOL);
  assert.ok(sender.welcome.peers.some(peer => peer.id === sender.welcome.peerId && peer.actorId === 'user-min'));
  assert.equal(legacy.welcome.cursorProtocol, undefined);
  assert.equal(legacy.welcome.peerId, undefined);
  assert.equal(legacy.welcome.cursors, undefined);

  const selection = sender.client.selection(1, 3);
  const packet = { type: 'cursor', epoch: first.epoch, selection };
  pending.send(packet);
  legacy.client.send(packet);
  sender.client.send({ ...packet, epoch: second.epoch });
  await Promise.all([pending.barrier(), legacy.client.barrier(), sender.client.barrier()]);
  await receiver.client.barrier();
  receiver.client.noCursor();

  sender.client.send({ ...packet, peerId: receiver.welcome.peerId, selection: { ...selection, actorId: 'user-seo' } });
  const expected = { type: 'cursor', epoch: first.epoch, peerId: sender.welcome.peerId, selection };
  assert.deepEqual(await receiver.client.next('cursor'), expected);
  await Promise.all([legacy.client.barrier(), otherRoom.client.barrier(), pending.barrier()]);
  legacy.client.noCursor();
  otherRoom.client.noCursor();
  pending.noCursor();

  const pendingWelcome = await f.hello(pending, first);
  assert.deepEqual(pendingWelcome.cursors, [{ peerId: sender.welcome.peerId, selection }]);
  const renegotiated = await f.hello(sender.client, first, false);
  assert.equal(renegotiated.peerId, sender.welcome.peerId);
  assert.equal(renegotiated.cursorProtocol, COLLABORATION_CURSOR_PROTOCOL);
  assert.equal((await f.hello(legacy.client, first)).cursorProtocol, undefined);

  sender.client.send({ ...packet, selection: null });
  const cleared = { ...expected, selection: null };
  assert.deepEqual(await receiver.client.next('cursor'), cleared);
  assert.deepEqual(await pending.next('cursor'), cleared);
  const live = await f.request<CollaborationSession>(`/documents/${first.document.id}/collaboration`);
  assert.deepEqual(live, first);
  const backup = await f.request<{ collabStates: object[] }>('/export');
  assert.equal(backup.collabStates.length, 2);
  assert.ok(backup.collabStates.every(state => Object.keys(state).sort().join(',') === 'documentId,epoch,schemaVersion,state'));
});

test('validated cursor pulses are rate limited, expire while idle, and clear on disconnect and reset', async t => {
  const f = await fixture(t);
  const room = await f.make('정리 검증 문서');
  const sender = await f.connect(room, 'user-min');
  const receiver = await f.connect(room, 'user-seo');
  const selection = sender.client.selection(1, 3);
  const moved = sender.client.selection(2);
  const packet = { type: 'cursor', epoch: room.epoch, selection };
  let now = 1_000;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });

  for (const bad of [
    { anchor: '!', head: selection.head },
    { anchor: encode(Buffer.alloc(MAX_COLLABORATION_CURSOR_BYTES + 1)), head: selection.head },
    { anchor: encode(Buffer.concat([Buffer.from(selection.anchor, 'base64'), Buffer.from([0])])), head: selection.head },
    { anchor: encode(Y.encodeRelativePosition(new Y.RelativePosition(null, 'other-root', null))), head: selection.head },
    {}, undefined,
  ]) {
    now += 80;
    sender.client.send({ ...packet, selection: bad });
    await sender.client.barrier();
  }
  await receiver.client.barrier();
  receiver.client.noCursor();

  const stateVector = Y.encodeStateVector(sender.client.doc);
  sender.client.text.insert(0, '편집 ');
  sender.client.send({ type: 'update', epoch: room.epoch, requestId: 'valid-after-bad-cursors', update: encode(Y.encodeStateAsUpdate(sender.client.doc, stateVector)) });
  const ack = await sender.client.next('ack');
  assert.equal(ack.document.version, room.document.version + 1);
  assert.equal(ack.document.plainText, '편집 협업 원본');

  now += 80;
  sender.client.send(packet);
  assert.deepEqual((await receiver.client.next('cursor')).selection, selection);
  sender.client.send({ ...packet, selection: moved });
  await sender.client.barrier();
  await receiver.client.barrier();
  receiver.client.noCursor();

  now += 10_000;
  t.mock.timers.tick(10_000);
  sender.client.send(packet);
  await sender.client.barrier();
  now += 20_000;
  t.mock.timers.tick(20_000);
  await receiver.client.barrier();
  receiver.client.noCursor();
  now += 10_000;
  t.mock.timers.tick(10_000);
  assert.equal((await receiver.client.next('cursor')).selection, null);
  t.mock.timers.reset();

  sender.client.send({ ...packet, selection: moved });
  assert.deepEqual((await receiver.client.next('cursor')).selection, moved);
  sender.client.socket.close();
  assert.deepEqual(await receiver.client.next('cursor'), { ...packet, peerId: sender.welcome.peerId, selection: null });
  await sender.client.closed;

  const current = await f.connect(room, 'user-min');
  current.client.send({ ...packet, selection: current.client.selection(0, 2) });
  await receiver.client.next('cursor');

  await f.request(`/documents/${room.document.id}`, 'PATCH', { expectedVersion: ack.document.version, content: content('새 세대') });
  const reset = await receiver.client.next('reset');
  assert.notEqual(reset.epoch, room.epoch);
  await Promise.all([receiver.client.closed, current.client.closed]);
  const newEpoch = await f.request<CollaborationSession>(`/documents/${room.document.id}/collaboration`);
  const rebuilt = await f.connect(newEpoch, 'user-seo');
  assert.deepEqual(rebuilt.welcome.cursors, []);
  assert.equal(rebuilt.welcome.epoch, reset.epoch);
});
