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

function fixture(t: TestContext, replacement?: ConstructorParameters<typeof CollaborationClient>[4]) {
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
  const client = new CollaborationClient({ enabled: true, epoch, schemaVersion: COLLABORATION_SCHEMA, document: snapshot }, self.actorId, () => views++, () => {}, replacement);
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

test('ACK of a restored snapshot cannot remove the original writer’s newer pending snapshot', t => {
  const { client: writer, socket, current, welcome, storage } = fixture(t);
  function append(target: CollaborationClient, value: string) {
    const paragraph = new Y.XmlElement('paragraph'), text = new Y.XmlText();
    text.insert(0, value);
    paragraph.insert(0, [text]);
    target.doc.getXmlFragment('default').push([paragraph]);
  }
  socket.receive(welcome);
  append(writer, 'first edit');
  assert.equal(storage.size, 1);
  const firstKey = [...storage.keys()][0];

  const reader = new CollaborationClient({ enabled: true, epoch, schemaVersion: COLLABORATION_SCHEMA, document: snapshot }, self.actorId, () => {}, () => {});
  try {
    reader.start();
    const reopened = current();
    reopened.open();
    reopened.receive(welcome);
    const sent = reopened.sent.find(message => message.type === 'update');
    assert.ok(sent && sent.type === 'update');
    assert.match(reader.doc.getXmlFragment('default').toString(), /first edit/);

    append(writer, 'later edit');
    assert.equal(storage.size, 1);
    const laterKey = [...storage.keys()][0];
    assert.notEqual(laterKey, firstKey);
    const laterSnapshot = storage.get(laterKey);
    reopened.receive({ type: 'ack', epoch, requestId: sent.requestId, stateVector: encodeBytes(Y.encodeStateVector(reader.doc)), document: snapshot });
    assert.equal(reader.view.pending, false);
    assert.equal(writer.view.pending, true);
    assert.deepEqual([...storage], [[laterKey, laterSnapshot]]);
  } finally {
    reader.destroy();
    reader.doc.destroy();
  }
  assert.equal(storage.size, 1);
});

test('schema 17 pending text rejoins its retained epoch and stays recoverable across an epoch replacement', t => {
  const { current, storage, welcome } = fixture(t);
  const source = new Y.Doc();
  const paragraph = new Y.XmlElement('paragraph');
  const text = new Y.XmlText();
  text.insert(0, '이전 버전에서 미저장한 본문');
  paragraph.insert(0, [text]);
  source.getXmlFragment('default').push([paragraph]);
  const update = encodeBytes(Y.encodeStateAsUpdate(source));
  source.destroy();
  const oldKey = `teamspace:collaboration-pending:${self.actorId}:${snapshot.id}:${epoch}:17:fixture`;
  const oldCache = JSON.stringify({ epoch, schemaVersion: 17, update, pending: true, updatedAt: '2026-11-25T00:00:00Z' });
  storage.set(oldKey, oldCache);
  const joined = new CollaborationClient({ enabled: true, epoch, schemaVersion: COLLABORATION_SCHEMA, document: snapshot }, self.actorId, () => {}, () => {});
  try {
    assert.equal(joined.view.phase, 'connecting');
    assert.equal(joined.view.pending, true);
    assert.equal(storage.get(oldKey), oldCache);
    const replacement = [...storage.values()].find(value => value !== oldCache);
    assert.ok(replacement);
    assert.equal(JSON.parse(replacement).schemaVersion, COLLABORATION_SCHEMA);
    joined.start();
    const socket = current();
    socket.open();
    socket.receive(welcome);
    const pending = socket.sent.find(message => message.type === 'update');
    assert.ok(pending);
    assert.match(joined.doc.getXmlFragment('default').toString(), /이전 버전에서 미저장한 본문/u);
    socket.receive({ type: 'ack', epoch, requestId: pending.requestId, stateVector: encodeBytes(Y.encodeStateVector(joined.doc)), document: snapshot });
    assert.equal(storage.size, 0);
  } finally { joined.destroy(); }

  storage.set(oldKey, oldCache);
  const archived = new CollaborationClient({ enabled: true, epoch: 'new-epoch', schemaVersion: COLLABORATION_SCHEMA, document: snapshot }, self.actorId, () => {}, () => {});
  try {
    assert.equal(archived.view.phase, 'recovery');
    assert.equal(archived.view.epoch, epoch);
    assert.equal(archived.view.pending, true);
    assert.equal(storage.size, 1);
  } finally { archived.destroy(); }
});

test('session replacement waits for composition and keeps the resulting unpublished transaction', async t => {
  let composing = true;
  let reconnected = false;
  const { client, socket, storage, welcome } = fixture(t, {
    isComposing: () => composing,
    restart: () => { reconnected = true; },
  });
  socket.receive(welcome);
  socket.receive({ type: 'reset', epoch: 'replacement', document: snapshot, reason: 'new body' });
  assert.equal(client.view.phase, 'offline');
  assert.equal(client.view.pending, false);
  assert.equal(reconnected, false);

  const paragraph = new Y.XmlElement('paragraph');
  const text = new Y.XmlText();
  text.insert(0, '한국어 조합 완료');
  paragraph.insert(0, [text]);
  client.doc.getXmlFragment('default').push([paragraph]);
  composing = false;
  await delay(75);
  assert.equal(client.view.phase, 'recovery');
  assert.equal(client.view.pending, true);
  assert.equal(client.view.epoch, epoch);
  assert.equal(reconnected, false);
  assert.equal(storage.size, 1);
  assert.equal(socket.sent.filter(message => message.type === 'update').length, 0);
  assert.match(client.doc.getXmlFragment('default').toString(), /한국어 조합 완료/u);
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
