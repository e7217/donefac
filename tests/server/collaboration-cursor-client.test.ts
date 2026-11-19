import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import * as Y from 'yjs';
import {
  COLLABORATION_CURSOR_PROTOCOL, COLLABORATION_SCHEMA, type CollaborationClientMessage,
  type CollaborationCursorSelection, type CollaborationServerMessage,
} from '../../shared/collaboration.js';
import type { DocPage } from '../../shared/types.js';
import { CollaborationClient, encodeBytes } from '../../src/lib/collaboration-client.js';

const epoch = 'document-epoch';
const self = { id: 'self-session', actorId: 'user-min', name: '내 작업자', color: '#334455' };
const peer = { id: 'peer-session', actorId: 'user-seo', name: '다른 작업자', color: '#446655' };
const snapshot: DocPage = {
  id: 'test-document', projectId: null, parentId: null, title: '합성 공동 편집 문서',
  content: { type: 'doc', content: [{ type: 'paragraph' }] }, plainText: '', icon: '', status: 'draft', version: 1,
  authorId: self.actorId, createdAt: '2025-11-19T00:00:00.000Z', updatedAt: '2025-11-19T00:00:00.000Z',
};

function fixture(t: TestContext) {
  class BrowserSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static current: BrowserSocket;
    readyState = BrowserSocket.CONNECTING;
    sent: CollaborationClientMessage[] = [];
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    constructor() { BrowserSocket.current = this; }
    open() { this.readyState = BrowserSocket.OPEN; this.onopen?.(); }
    send(value: string) { this.sent.push(JSON.parse(value) as CollaborationClientMessage); }
    receive(message: CollaborationServerMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
    close() { this.readyState = 3; }
    get cursors() { return this.sent.filter(message => message.type === 'cursor'); }
  }
  const storage = new Map<string, string>();
  const browser = Object.assign(new EventTarget(), { location: { href: 'http://127.0.0.1/' } });
  const values = {
    window: browser, navigator: { onLine: true }, WebSocket: BrowserSocket,
    localStorage: {
      get length() { return storage.size; },
      key(index: number) { return [...storage.keys()][index] ?? null; },
      getItem(key: string) { return storage.get(key) ?? null; },
      setItem(key: string, value: string) { storage.set(key, value); },
      removeItem(key: string) { storage.delete(key); },
    },
  };
  const originals = Object.entries(values).map(([name, value]) => {
    const prior = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    return { name, prior };
  });
  let views = 0;
  const client = new CollaborationClient({ enabled: true, epoch, schemaVersion: COLLABORATION_SCHEMA, document: snapshot }, self.actorId, () => views++, () => {});
  const server = new Y.Doc();
  t.after(() => {
    client.destroy();
    client.doc.destroy();
    server.destroy();
    for (const { name, prior } of originals) {
      if (prior) Object.defineProperty(globalThis, name, prior);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  const welcome = { type: 'welcome', epoch, schemaVersion: COLLABORATION_SCHEMA, update: encodeBytes(Y.encodeStateAsUpdate(server)),
    stateVector: encodeBytes(Y.encodeStateVector(server)), document: snapshot, peers: [self, peer] } as const;
  client.start();
  const socket = BrowserSocket.current;
  socket.open();
  return { browser, client, socket, current: () => BrowserSocket.current, welcome: { ...welcome, peers: [...welcome.peers] }, storage, views: () => views };
}

function position(doc: Y.Doc, offset = 0): string {
  return encodeBytes(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(doc.getXmlFragment('default'), offset)));
}

test('cursor capability negotiation keeps editing compatible with an older server', t => {
  const { client, socket, welcome } = fixture(t);
  const hello = socket.sent[0];
  assert.equal(hello.type === 'hello' && hello.cursorProtocol, COLLABORATION_CURSOR_PROTOCOL);
  const anchor = position(client.doc);
  client.setCursor({ anchor, head: anchor });
  socket.receive(welcome);
  socket.receive({ type: 'cursor', epoch, peerId: peer.id, selection: { anchor, head: anchor } });
  assert.deepEqual(client.getRemoteCursors(), []);
  assert.equal(socket.cursors.length, 0);
  client.doc.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]);
  assert.equal(socket.sent.at(-1)?.type, 'update');
  assert.equal(client.view.phase, 'connected');
});

test('cursor delivery waits for ACK, keeps the newest position and follows connection state', async t => {
  const { browser, client, socket, current, welcome, storage, views } = fixture(t);
  let cursorNotifications = 0;
  const unsubscribe = client.subscribeCursors(() => cursorNotifications++);
  const anchor = position(client.doc);
  const collapsed = { anchor, head: anchor };
  socket.receive({ ...welcome, cursorProtocol: COLLABORATION_CURSOR_PROTOCOL, peerId: self.id, cursors: [
    { peerId: self.id, selection: collapsed }, { peerId: 'unknown', selection: collapsed }, { peerId: peer.id, selection: collapsed },
  ] });
  await Promise.resolve();
  assert.deepEqual(client.getRemoteCursors(), [{ peer, selection: collapsed }]);
  const initial = client.getRemoteCursors();
  const before = views();
  socket.receive({ type: 'cursor', epoch: 'prior-epoch', peerId: peer.id, selection: null });
  socket.receive({ type: 'cursor', epoch, peerId: 'unknown', selection: collapsed });
  assert.equal(client.getRemoteCursors(), initial);
  assert.equal(views(), before);
  assert.equal(cursorNotifications, 1);

  client.doc.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]);
  const update = socket.sent.at(-1);
  assert.ok(update?.type === 'update');
  const head = position(client.doc);
  assert.notEqual(head, anchor);
  const next = { anchor, head };
  client.setCursor(next);
  assert.equal(socket.cursors.length, 0);
  assert.equal([...storage.values()].some(value => value.includes('"anchor"')), false);
  socket.receive({ type: 'ack', epoch, requestId: update.requestId, stateVector: encodeBytes(Y.encodeStateVector(client.doc)), document: snapshot });
  assert.deepEqual(socket.cursors.map(message => message.selection), [next]);
  assert.equal(storage.size, 0);

  client.setCursor({ anchor: head, head });
  const last = { anchor: head, head: anchor };
  client.setCursor(last);
  assert.equal(socket.cursors.length, 1);
  await delay(125);
  assert.deepEqual(socket.cursors.map(message => message.selection), [next, last]);
  client.setCursor(collapsed);
  client.setCursor(null);
  assert.equal(socket.cursors.at(-1)?.selection, null);
  await delay(125);
  assert.deepEqual(socket.cursors.map(message => message.selection), [next, last, null]);

  socket.receive({ type: 'presence', peers: [self] });
  assert.deepEqual(client.getRemoteCursors(), []);
  socket.receive({ type: 'presence', peers: [self, peer] });
  const remoteSelection: CollaborationCursorSelection = { anchor: head, head };
  socket.receive({ type: 'cursor', epoch, peerId: peer.id, selection: remoteSelection });
  assert.deepEqual(client.getRemoteCursors(), [{ peer, selection: remoteSelection }]);
  client.setCursor(collapsed);
  browser.dispatchEvent(new Event('offline'));
  assert.deepEqual(client.getRemoteCursors(), []);
  assert.equal(client.view.phase, 'offline');
  browser.dispatchEvent(new Event('online'));
  const reconnected = current();
  assert.notEqual(reconnected, socket);
  reconnected.open();
  reconnected.receive({ ...welcome, cursorProtocol: COLLABORATION_CURSOR_PROTOCOL, peerId: self.id,
    cursors: [{ peerId: peer.id, selection: remoteSelection }] });
  assert.deepEqual(reconnected.cursors.map(message => message.selection), [collapsed]);
  assert.deepEqual(client.getRemoteCursors(), [{ peer, selection: remoteSelection }]);
  reconnected.receive({ type: 'reset', epoch: 'new-epoch', document: snapshot, reason: '합성 복원' });
  assert.deepEqual(client.getRemoteCursors(), []);
  assert.equal(client.view.phase, 'recovery');
  unsubscribe();
});
