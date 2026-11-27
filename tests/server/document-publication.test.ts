import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import { createApp } from '../../server/app.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import { DOCUMENT_CONTENT_SCHEMA_VERSION } from '../../shared/document-nodes.js';
import { COLLABORATION_SCHEMA, type CollaborationServerMessage, type CollaborationSession } from '../../shared/collaboration.js';
import type {
  ApiKeyCreated,
  DocPage,
  DocRevision,
  DocumentPublicationState,
  DocumentPublicationView,
  RichContent,
  TeamNotification,
  WorkspaceSnapshot,
} from '../../shared/types.js';

type Backup = WorkspaceSnapshot & {
  schemaVersion: number;
  exportedAt: string;
  revisions: DocRevision[];
  documentPublications: DocumentPublicationState[];
  teamNotifications: TeamNotification[];
};
type Action = 'request' | 'publish' | 'approve' | 'request_changes' | 'withdraw';
const content = (text: string): RichContent => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'donefac-document-publication-'));
  const service = createApp({ dataDir: dir, outboundWorker: false });
  const server = service.app.listen(0, '127.0.0.1');
  service.attachWebSocket(server);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const database = new DatabaseSync(join(dir, 'donefac.sqlite'));
  database.exec('PRAGMA foreign_keys=ON');
  const call = async <T = unknown>(path: string, method = 'GET', body?: unknown, actor = 'user-min', headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}/api${path}`, {
      method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actor, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() as T };
  };
  return {
    base, database, call,
    async close() {
      service.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
      database.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function make(f: Fixture, text = '검토할 저장된 원문') {
  const response = await f.call<DocPage>('/documents', 'POST', {
    projectId: 'project-neo', title: `발행 검증 ${randomUUID()}`, content: content(text),
  });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  return response.data;
}
async function publication(f: Fixture, id: string) {
  const response = await f.call<DocumentPublicationView>(`/documents/${id}/publication`);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data;
}
async function document(f: Fixture, id: string) {
  const response = await f.call<WorkspaceSnapshot>('/workspace');
  assert.equal(response.status, 200);
  const current = response.data.documents.find(value => value.id === id);
  assert.ok(current);
  return current;
}
async function edit(f: Fixture, before: DocPage, text: string, title = before.title) {
  const response = await f.call<DocPage>(`/documents/${before.id}`, 'PATCH', {
    expectedVersion: before.version, title, content: content(text), contentSchemaVersion: DOCUMENT_CONTENT_SCHEMA_VERSION,
  });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data;
}
async function transition(f: Fixture, state: DocumentPublicationView, action: Action, actor: string, extra: Record<string, unknown> = {}) {
  return f.call<DocumentPublicationView>(`/documents/${state.documentId}/publication`, 'POST', {
    action, expectedVersion: state.version, workspaceGeneration: state.workspaceGeneration, ...extra,
  }, actor);
}
async function accepted(result: ReturnType<typeof transition>) {
  const response = await result;
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data;
}
async function requestReview(f: Fixture, doc: DocPage, actor = 'user-min', reviewerId = 'user-seo') {
  return accepted(transition(f, await publication(f, doc.id), 'request', actor, {
    expectedDocumentVersion: doc.version, reviewerId, note: '검토할 저장본을 확인해 주세요.',
  }));
}
async function snapshot(f: Fixture, state: DocumentPublicationView, kind: 'review' | 'published') {
  const pointer = state[kind];
  assert.ok(pointer);
  const response = await f.call<DocRevision>(`/documents/${state.documentId}/publication/snapshot?${new URLSearchParams({ kind, revisionId: pointer.revisionId })}`);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data;
}
function diskRevision(f: Fixture, id: string) {
  const row = f.database.prepare('SELECT json FROM revisions WHERE id=?').get(id) as { json: string } | undefined;
  assert.ok(row);
  return JSON.parse(row.json) as DocRevision;
}

test('comparison reads the exact pinned pair after editing and rejects stale state, pointers and restore generations', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const baseline = await make(f, '처음 발행한 본문');
  const published = await accepted(transition(f, await requestReview(f, baseline), 'publish', 'user-seo'));
  const requested = await edit(f, baseline, '이번 검토 요청의 본문', '검토 요청 제목');
  const state = await accepted(transition(f, published, 'request', 'user-min', {
    expectedDocumentVersion: requested.version, reviewerIds: ['user-seo', 'user-jun'],
  }));
  const later = await edit(f, requested, '비교에서 제외할 다음 편집', '다음 편집 제목');
  const publishedRevision = await snapshot(f, state, 'published');
  const reviewRevision = await snapshot(f, state, 'review');
  type Comparison = { version: number; workspaceGeneration: string | null; published: DocRevision; review: DocRevision };
  const comparison = (view: DocumentPublicationView, options: Record<string, string> = {}, id = baseline.id) => f.call<Comparison>(
    `/documents/${id}/publication/comparison?${new URLSearchParams({
      expectedVersion: String(view.version), workspaceGeneration: view.workspaceGeneration ?? '',
      publishedRevisionId: publishedRevision.id, reviewRevisionId: reviewRevision.id, ...options,
    })}`, 'GET', undefined, 'user-seo',
  );
  const saved = await f.call<Backup>('/export');
  assert.equal(saved.status, 200);
  assert.equal(publishedRevision.version, baseline.version);
  assert.equal(reviewRevision.version, requested.version);
  assert.equal(publishedRevision.plainText, '처음 발행한 본문');
  assert.equal(reviewRevision.plainText, '이번 검토 요청의 본문');
  const pair = { version: state.version, workspaceGeneration: state.workspaceGeneration, published: publishedRevision, review: reviewRevision };
  assert.deepEqual(await comparison(state), { status: 200, data: pair });
  assert.equal((await comparison(state, { publishedRevisionId: reviewRevision.id })).status, 409);
  const latestRevision = saved.data.revisions.find(row => row.documentId === baseline.id && row.version === later.version);
  assert.ok(latestRevision);
  assert.equal((await comparison(state, { reviewRevisionId: latestRevision.id })).status, 409);
  assert.equal((await comparison(state, {}, 'missing-document')).status, 404);
  assert.deepEqual(await publication(f, baseline.id), { ...state, documentVersion: later.version });
  const rechecked = (await f.call<Backup>('/export')).data;
  for (const field of ['documents', 'revisions', 'documentPublications', 'activities', 'teamNotifications'] as const) {
    assert.deepEqual(rechecked[field], saved.data[field]);
  }

  const partial = await accepted(transition(f, state, 'approve', 'user-seo', { note: '먼저 검토를 마쳤습니다.' }));
  assert.equal(partial.version, state.version + 1);
  assert.equal(partial.published?.revisionId, publishedRevision.id);
  assert.equal(partial.review?.revisionId, reviewRevision.id);
  assert.equal((await comparison(state)).status, 409);
  assert.deepEqual(await comparison(partial), { status: 200, data: { ...pair, version: partial.version } });

  const backup = (await f.call<Backup>('/export')).data;
  assert.equal((await f.call('/import', 'POST', { data: backup })).status, 200);
  const restored = await publication(f, baseline.id);
  assert.equal(restored.version, partial.version);
  assert.notEqual(restored.workspaceGeneration, partial.workspaceGeneration);
  assert.equal((await comparison(partial)).status, 409);
  assert.deepEqual(await comparison(restored), { status: 200, data: { ...pair, version: partial.version, workspaceGeneration: restored.workspaceGeneration } });
});

test('manual review freezes exactly the persisted candidate, enforces the designated reviewer and keeps later drafts independent', async () => {
  const f = await fixture();
  try {
    let doc = await make(f, '처음 저장한 본문');
    const initial = await publication(f, doc.id);
    assert.equal(initial.version, 0);
    assert.equal(initial.documentVersion, doc.version);
    assert.equal(initial.workspaceGeneration, null);
    assert.equal(initial.review, null);
    assert.equal(initial.published, null);
    const beforeRequest = await f.call<Backup>('/export');
    assert.deepEqual(beforeRequest.data.documentPublications, []);
    doc = await edit(f, doc, '요청할 때 서버에 저장된 본문', '검토 후보 제목');
    assert.equal((await transition(f, initial, 'request', 'user-min', { expectedDocumentVersion: initial.documentVersion, reviewerId: 'user-seo' })).status, 409);
    assert.equal((await publication(f, doc.id)).version, 0);

    const requested = await requestReview(f, doc);
    assert.equal(requested.version, 1);
    assert.equal(requested.review!.requestedById, 'user-min');
    assert.equal(requested.review!.reviewerId, 'user-seo');
    assert.equal(requested.review!.changesRequested, null);
    assert.equal(requested.reviewRevision!.id, requested.review!.revisionId);
    const frozen = await snapshot(f, requested, 'review');
    assert.deepEqual({ title: frozen.title, content: frozen.content, plainText: frozen.plainText, version: frozen.version }, {
      title: doc.title, content: doc.content, plainText: doc.plainText, version: doc.version,
    });
    assert.deepEqual(diskRevision(f, frozen.id), frozen);
    doc = await edit(f, doc, '검토 요청 이후에도 작성하는 다음 초안', '새 초안 제목');
    const whileEditing = await publication(f, doc.id);
    assert.equal(whileEditing.documentVersion, doc.version);
    assert.equal(whileEditing.version, requested.version);
    assert.deepEqual(await snapshot(f, whileEditing, 'review'), frozen);
    assert.equal((await transition(f, whileEditing, 'publish', 'user-min')).status, 403);
    assert.equal((await transition(f, whileEditing, 'publish', 'user-jun')).status, 403);
    assert.equal((await transition(f, whileEditing, 'publish', 'missing-actor')).status, 400);
    assert.equal((await publication(f, doc.id)).version, requested.version);

    const published = await accepted(transition(f, whileEditing, 'publish', 'user-seo', { note: '저장된 검토본 승인' }));
    assert.equal(published.review, null);
    assert.equal(published.published!.revisionId, frozen.id);
    assert.equal(published.published!.publishedById, 'user-seo');
    assert.deepEqual(await snapshot(f, published, 'published'), frozen);
    assert.equal((await document(f, doc.id)).plainText, '검토 요청 이후에도 작성하는 다음 초안');
    assert.equal((await document(f, doc.id)).title, '새 초안 제목');
    assert.equal((await transition(f, whileEditing, 'publish', 'user-seo')).status, 409);
  } finally { await f.close(); }
});

test('a previous published pointer survives feedback, resubmission and requester-only withdrawal with stale transitions rejected', async () => {
  const f = await fixture();
  try {
    let doc = await make(f, '먼저 발행할 본문');
    const initial = await publication(f, doc.id);
    assert.equal((await transition(f, initial, 'request', 'user-min', { expectedDocumentVersion: doc.version, reviewerId: 'user-min' })).status, 400);
    assert.equal((await transition(f, initial, 'request', 'user-min', { expectedDocumentVersion: doc.version, reviewerId: 'missing-reviewer' })).status, 400);
    let state = await requestReview(f, doc);
    state = await accepted(transition(f, state, 'publish', 'user-seo'));
    const publishedPointer = structuredClone(state.published);
    const publishedBody = await snapshot(f, state, 'published');
    doc = await edit(f, doc, '다음 검토 후보');
    state = await requestReview(f, doc, 'user-jun', 'user-seo');
    assert.deepEqual(state.published, publishedPointer);
    const reviewBody = await snapshot(f, state, 'review');
    assert.deepEqual(await snapshot(f, state, 'published'), publishedBody);
    assert.equal((await transition(f, state, 'request', 'user-min', { expectedDocumentVersion: doc.version, reviewerId: 'user-seo' })).status, 409);
    assert.equal((await transition(f, state, 'withdraw', 'user-min')).status, 403);
    assert.equal((await transition(f, state, 'request_changes', 'user-jun', { note: '스스로 수정 요청 불가' })).status, 403);
    assert.equal((await transition(f, state, 'request_changes', 'user-seo', { note: '   ' })).status, 400);
    const oldPending = state;
    state = await accepted(transition(f, state, 'request_changes', 'user-seo', { note: '검증 근거를 추가해 주세요.' }));
    assert.equal(state.review!.changesRequested!.byId, 'user-seo');
    assert.equal(state.review!.changesRequested!.note, '검증 근거를 추가해 주세요.');
    assert.deepEqual(await snapshot(f, state, 'review'), reviewBody);
    assert.deepEqual(state.published, publishedPointer);
    assert.equal((await transition(f, oldPending, 'publish', 'user-seo')).status, 409);
    assert.equal((await transition(f, state, 'publish', 'user-seo')).status, 409);

    doc = await edit(f, doc, '검증 근거를 추가한 새 후보');
    state = await requestReview(f, doc, 'user-min', 'user-jun');
    assert.equal(state.review!.requestedById, 'user-min');
    assert.equal(state.review!.reviewerId, 'user-jun');
    assert.equal(state.review!.changesRequested, null);
    assert.notEqual(state.review!.revisionId, reviewBody.id);
    assert.equal((await f.call(`/documents/${doc.id}/publication/snapshot?kind=review&revisionId=${reviewBody.id}`)).status, 409);
    assert.deepEqual(state.published, publishedPointer);
    assert.equal((await transition(f, state, 'withdraw', 'user-seo')).status, 403);
    const pending = state;
    state = await accepted(transition(f, state, 'withdraw', 'user-min', { note: '초안 재정리' }));
    assert.equal(state.review, null);
    assert.deepEqual(state.published, publishedPointer);
    assert.deepEqual(await snapshot(f, state, 'published'), publishedBody);
    assert.equal((await transition(f, pending, 'withdraw', 'user-min')).status, 409);
    assert.equal((await document(f, doc.id)).plainText, doc.plainText);
    assert.equal((await f.call(`/documents/${doc.id}/publication/snapshot?kind=review&revisionId=${pending.review!.revisionId}`)).status, 404);
  } finally { await f.close(); }
});

class Peer {
  readonly socket: WebSocket;
  readonly doc = new Y.Doc();
  private messages: CollaborationServerMessage[] = [];
  private waiters: {
    match: (message: CollaborationServerMessage) => boolean;
    resolve: (message: CollaborationServerMessage) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];
  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on('error', () => {});
    this.socket.on('message', raw => {
      const message = JSON.parse(raw.toString()) as CollaborationServerMessage;
      const index = this.waiters.findIndex(waiter => waiter.match(message));
      if (index < 0) this.messages.push(message);
      else {
        const waiter = this.waiters.splice(index, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    });
  }
  send(message: unknown) { this.socket.send(JSON.stringify(message)); }
  next<T extends CollaborationServerMessage['type']>(type: T, requestId?: string): Promise<Extract<CollaborationServerMessage, { type: T }>> {
    const match = (message: CollaborationServerMessage) => message.type === type && (requestId === undefined || 'requestId' in message && message.requestId === requestId);
    const index = this.messages.findIndex(match);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0] as Extract<CollaborationServerMessage, { type: T }>);
    return new Promise((resolve, reject) => {
      const waiter = {
        match,
        resolve: (message: CollaborationServerMessage) => resolve(message as Extract<CollaborationServerMessage, { type: T }>),
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter(value => value !== waiter);
          reject(new Error(`Publication test did not receive WebSocket ${type}`));
        }, 5000),
      };
      this.waiters.push(waiter);
    });
  }
  dispose() {
    this.socket.terminate();
    this.doc.destroy();
    for (const waiter of this.waiters) clearTimeout(waiter.timer);
    this.waiters = [];
  }
}
async function connect(f: Fixture, session: CollaborationSession) {
  const peer = new Peer(`${f.base.replace('http:', 'ws:')}/api/collaboration?${new URLSearchParams({ documentId: session.document.id, actorId: 'user-min' })}`);
  await once(peer.socket, 'open');
  peer.send({ type: 'hello', epoch: session.epoch, schemaVersion: COLLABORATION_SCHEMA, stateVector: Buffer.from(Y.encodeStateVector(peer.doc)).toString('base64') });
  const welcome = await peer.next('welcome');
  Y.applyUpdate(peer.doc, Buffer.from(welcome.update, 'base64'));
  return peer;
}
async function typeAndCommit(peer: Peer, epoch: string, text: string) {
  const vector = Y.encodeStateVector(peer.doc);
  ((peer.doc.getXmlFragment('default').get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, text);
  const requestId = randomUUID();
  peer.send({ type: 'update', epoch, requestId, update: Buffer.from(Y.encodeStateAsUpdate(peer.doc, vector)).toString('base64') });
  return peer.next('ack', requestId);
}

test('Yjs review captures the durable ACK snapshot and audit failure rolls back both a new revision and publication state', async () => {
  const f = await fixture();
  let peer: Peer | undefined;
  try {
    const doc = await make(f, '공동 편집 원문');
    const enabled = await f.call<CollaborationSession>(`/documents/${doc.id}/collaboration/enable`, 'POST', { expectedVersion: doc.version });
    assert.equal(enabled.status, 200);
    peer = await connect(f, enabled.data);
    const committed = await typeAndCommit(peer, enabled.data.epoch!, 'ACK까지 저장한 ');
    assert.equal(committed.document.plainText, 'ACK까지 저장한 공동 편집 원문');
    const state = await publication(f, doc.id);
    const revisions = (await f.call<DocRevision[]>(`/documents/${doc.id}/revisions`)).data;
    assert.ok(!revisions.some(revision => revision.version === committed.document.version));
    f.database.exec(`CREATE TRIGGER reject_publication_audit BEFORE INSERT ON activities WHEN json_extract(NEW.json,'$.resourceId')='${doc.id}' BEGIN SELECT RAISE(ABORT,'synthetic publication audit failure'); END`);
    try {
      const failed = await transition(f, state, 'request', 'user-min', { expectedDocumentVersion: committed.document.version, reviewerId: 'user-seo' });
      assert.ok(failed.status >= 400);
      assert.deepEqual(await publication(f, doc.id), state);
      assert.deepEqual((await f.call<DocRevision[]>(`/documents/${doc.id}/revisions`)).data, revisions);
      assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM document_publications WHERE document_id=?').get(doc.id)!.count, 0);
    } finally { f.database.exec('DROP TRIGGER reject_publication_audit'); }

    const requested = await requestReview(f, committed.document);
    const frozen = await snapshot(f, requested, 'review');
    assert.deepEqual({ version: frozen.version, title: frozen.title, content: frozen.content, plainText: frozen.plainText }, {
      version: committed.document.version, title: committed.document.title, content: committed.document.content, plainText: committed.document.plainText,
    });
    assert.deepEqual(diskRevision(f, frozen.id), frozen);
    const metadata = await f.call<DocPage>(`/documents/${doc.id}`, 'PATCH', { expectedVersion: committed.document.version, title: '후속 공동 편집 제목' }, 'user-jun');
    assert.equal(metadata.status, 200);
    const later = await typeAndCommit(peer, enabled.data.epoch!, '발행과 독립인 후속 초안 ');
    assert.equal(later.document.title, '후속 공동 편집 제목');
    assert.deepEqual(await snapshot(f, await publication(f, doc.id), 'review'), frozen);
    const published = await accepted(transition(f, requested, 'publish', 'user-seo'));
    assert.deepEqual(await snapshot(f, published, 'published'), frozen);
    assert.equal((await document(f, doc.id)).plainText, later.document.plainText);
    assert.equal((await document(f, doc.id)).version, later.document.version);
    assert.equal((await f.call<CollaborationSession>(`/documents/${doc.id}/collaboration`)).data.epoch, enabled.data.epoch);
  } finally { peer?.dispose(); await f.close(); }
});

test('native14 preserves publication snapshots, rejects invalid/older references atomically and rotates restore CAS tokens before FK cleanup', async () => {
  const f = await fixture();
  try {
    let doc = await make(f, '백업할 발행 원문');
    let state = await requestReview(f, doc);
    assert.equal((await transition(f, state, 'publish', 'user-seo', { note: '가'.repeat(2001) })).status, 400);
    assert.deepEqual(await publication(f, doc.id), state);
    state = await accepted(transition(f, state, 'publish', 'user-seo', { note: '발행 근거를 보관합니다.' }));
    const publishedSnapshot = await snapshot(f, state, 'published');
    doc = await edit(f, doc, '백업할 진행 중 검토 원문');
    state = await requestReview(f, doc);
    const reviewSnapshot = await snapshot(f, state, 'review');
    const backupResponse = await f.call<Backup>('/export');
    assert.equal(backupResponse.status, 200);
    const backup = backupResponse.data;
    assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
    assert.deepEqual(backup.documentPublications, [{ documentId: state.documentId, version: state.version, review: state.review, published: state.published }]);
    assert.deepEqual(backup.revisions.find(value => value.id === reviewSnapshot.id), reviewSnapshot);
    assert.deepEqual(backup.revisions.find(value => value.id === publishedSnapshot.id), publishedSnapshot);
    const apiKey = await f.call<ApiKeyCreated>('/api-keys', 'POST', { name: '발행 백업 원자성 합성 키', access: 'read', projectIds: null, expiresAt: null });
    assert.equal(apiKey.status, 201);
    const token = apiKey.data.token;
    const keyStatus = async () => (await f.call('/v1/projects', 'GET', undefined, 'user-jun', { Authorization: `Bearer ${token}` })).status;
    assert.equal(await keyStatus(), 200);

    const otherRevision = backup.revisions.find(value => value.documentId !== doc.id)!;
    assert.ok(otherRevision);
    const invalid: Backup[] = [];
    const missing = structuredClone(backup); missing.documentPublications[0].review!.revisionId = 'missing-revision'; invalid.push(missing);
    const wrongDocument = structuredClone(backup); wrongDocument.documentPublications[0].review!.revisionId = otherRevision.id; invalid.push(wrongDocument);
    const wrongActor = structuredClone(backup); wrongActor.documentPublications[0].published!.publishedById = 'user-jun'; invalid.push(wrongActor);
    const future = structuredClone(backup); future.documentPublications[0].review!.requestedAt = new Date(Date.parse(backup.exportedAt) + 1000).toISOString(); invalid.push(future);
    const hiddenFeature = structuredClone(backup); hiddenFeature.schemaVersion = 13; invalid.push(hiddenFeature);
    for (const value of invalid) {
      assert.equal((await f.call('/import', 'POST', { data: value })).status, 400);
      assert.deepEqual(await publication(f, doc.id), state);
      assert.equal(await keyStatus(), 200);
    }
    // This fails after DELETE users/API-key cascades and canonical reinsertion,
    // proving rollback restores publication rows, generations and credentials.
    const lateFailure = structuredClone(backup);
    assert.ok(lateFailure.resourceLinks.length);
    lateFailure.resourceLinks[0].documentId = 'missing-document';
    assert.equal((await f.call('/import', 'POST', { data: lateFailure })).status, 404);
    assert.deepEqual(await publication(f, doc.id), state);
    assert.deepEqual(await snapshot(f, state, 'review'), reviewSnapshot);
    assert.deepEqual(await snapshot(f, state, 'published'), publishedSnapshot);
    assert.equal(await keyStatus(), 200);
    assert.deepEqual(f.database.prepare('PRAGMA foreign_key_check').all(), []);

    assert.equal((await f.call('/import', 'POST', { data: backup })).status, 200);
    const restored = await publication(f, doc.id);
    assert.equal(restored.version, state.version);
    assert.notEqual(restored.workspaceGeneration, state.workspaceGeneration);
    assert.equal(typeof restored.workspaceGeneration, 'string');
    assert.deepEqual(restored.review, state.review);
    assert.deepEqual(restored.published, state.published);
    assert.equal(restored.published?.note, '발행 근거를 보관합니다.');
    assert.deepEqual(await snapshot(f, restored, 'review'), reviewSnapshot);
    assert.deepEqual(await snapshot(f, restored, 'published'), publishedSnapshot);
    assert.equal(await keyStatus(), 401);
    assert.equal((await transition(f, state, 'publish', 'user-seo')).status, 409);
    assert.equal((await transition(f, restored, 'withdraw', 'user-min', { workspaceGeneration: state.workspaceGeneration })).status, 409);
    assert.deepEqual(await publication(f, doc.id), restored);
    const roundtrip = (await f.call<Backup>('/export')).data;
    assert.deepEqual(roundtrip.documentPublications, backup.documentPublications);

    const legacy = structuredClone(backup) as Partial<Backup> & Pick<Backup, 'documents'>;
    legacy.schemaVersion = 13;
    delete legacy.documentPublications;
    delete legacy.teamNotifications;
    legacy.documents.find(value => value.id === doc.id)!.status = 'published';
    assert.equal((await f.call('/import', 'POST', { data: legacy })).status, 200);
    const reset = await publication(f, doc.id);
    assert.equal(reset.version, 0);
    assert.equal(reset.review, null);
    assert.equal(reset.published, null);
    assert.notEqual(reset.workspaceGeneration, restored.workspaceGeneration);
    assert.equal((await document(f, doc.id)).status, 'published');
    assert.equal((await f.call(`/documents/${doc.id}/publication/snapshot?kind=published&revisionId=${publishedSnapshot.id}`)).status, 404);
    assert.equal((await transition(f, reset, 'request', 'user-min', { workspaceGeneration: restored.workspaceGeneration, expectedDocumentVersion: reset.documentVersion, reviewerId: 'user-seo' })).status, 409);

    const requestedAgain = await requestReview(f, await document(f, doc.id));
    assert.ok(requestedAgain.review);
    const liveDocument = await document(f, doc.id);
    assert.equal((await f.call(`/documents/${doc.id}?expectedVersion=${liveDocument.version}`, 'DELETE')).status, 200);
    assert.equal((await f.call(`/documents/${doc.id}/publication`)).status, 404);
    assert.equal((await f.call(`/documents/${doc.id}/publication/snapshot?kind=review&revisionId=${requestedAgain.review!.revisionId}`)).status, 404);
    assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM document_publications WHERE document_id=?').get(doc.id)!.count, 0);
    assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM revisions WHERE document_id=?').get(doc.id)!.count, 0);
    assert.deepEqual(f.database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { await f.close(); }
});

test('exact publication links require recorded approval and retain earlier bodies through native and trash restore', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const first = await make(f, '처음 발행한 지침');
  const path = `/documents/${first.id}/publication/snapshot`;
  const snapshotPath = (revisionId: string, kind = 'published') => `${path}?${new URLSearchParams({ kind, revisionId })}`;
  let state = await accepted(transition(f, await requestReview(f, first), 'publish', 'user-seo'));
  const earlier = [await snapshot(f, state, 'published')];
  const second = await edit(f, first, '두 번째 발행 지침');
  const groupReview = await accepted(transition(f, state, 'request', 'user-min', {
    expectedDocumentVersion: second.version, reviewerIds: ['user-seo', 'user-jun'],
  }));
  const partial = await accepted(transition(f, groupReview, 'approve', 'user-seo'));
  assert.equal((await f.call(snapshotPath(partial.review!.revisionId))).status, 409);
  state = await accepted(transition(f, partial, 'approve', 'user-jun'));
  earlier.push(await snapshot(f, state, 'published'));
  const latest = await edit(f, second, '현재 발행한 지침');
  const latestRequest = await requestReview(f, latest);
  f.database.exec(`CREATE TRIGGER reject_publication_history BEFORE UPDATE ON document_publications
    WHEN json_array_length(NEW.json,'$.previousPublications')=2 BEGIN SELECT RAISE(ABORT,'synthetic publication history failure'); END;`);
  try {
    assert.equal((await transition(f, latestRequest, 'publish', 'user-seo')).status, 500);
    assert.deepEqual(await publication(f, first.id), latestRequest);
    assert.equal((await f.call(snapshotPath(latestRequest.review!.revisionId))).status, 409);
  } finally { f.database.exec('DROP TRIGGER reject_publication_history'); }
  state = await accepted(transition(f, latestRequest, 'publish', 'user-seo'));
  const current = await snapshot(f, state, 'published');
  const pending = await edit(f, latest, '승인 대기 중인 지침');
  state = await requestReview(f, pending);
  const review = await snapshot(f, state, 'review');
  const draft = await edit(f, pending, '검토에 포함되지 않은 초안');
  state = await publication(f, first.id);
  const unrelated = await make(f, '같은 프로젝트의 다른 문서');

  const exported = await f.call<Backup>('/export');
  assert.equal(exported.status, 200);
  assert.equal(exported.data.schemaVersion, 131);
  const backup = exported.data;
  const unknownRevision = (doc: DocPage) => backup.revisions.find(value => value.documentId === doc.id && value.version === doc.version)!.id;
  const history = backup.documentPublications.find(value => value.documentId === first.id)!.previousPublications!;
  assert.deepEqual(history.map(value => value.revisionId), earlier.map(value => value.id));
  assert.deepEqual(history[1].approvals?.map(value => value.byId), ['user-seo', 'user-jun']);
  async function verifyLinks() {
    for (const revision of [...earlier, current]) {
      assert.deepEqual(await f.call(snapshotPath(revision.id)), { status: 200, data: revision });
      assert.equal((await f.call(snapshotPath(revision.id, 'review'))).status, 409);
    }
    for (const revisionId of [review.id, unknownRevision(draft), unknownRevision(unrelated)]) {
      assert.equal((await f.call(snapshotPath(revisionId))).status, 409);
    }
    assert.deepEqual(await f.call(snapshotPath(review.id, 'review')), { status: 200, data: review });
  }
  await verifyLinks();

  const portableImport = (data: Backup) => f.call('/import', 'POST', { data });
  const withoutHistorySupport = structuredClone(backup);
  withoutHistorySupport.schemaVersion = 130;
  assert.equal((await portableImport(withoutHistorySupport)).status, 400);
  for (const corrupt of [
    (entry: DocumentPublicationState) => { entry.previousPublications!.reverse(); },
    (entry: DocumentPublicationState) => { entry.previousPublications!.push(entry.published!); },
    (entry: DocumentPublicationState) => { entry.previousPublications![0].revisionId = unknownRevision(unrelated); },
    (entry: DocumentPublicationState) => { entry.previousPublications![0].publishedById = 'user-min'; },
  ]) {
    const invalid = structuredClone(backup);
    corrupt(invalid.documentPublications.find(value => value.documentId === first.id)!);
    assert.equal((await portableImport(invalid)).status, 400);
    assert.deepEqual(await publication(f, first.id), state);
  }
  assert.equal((await portableImport(backup)).status, 200);
  await verifyLinks();
  const live = await document(f, first.id);
  const archived = await f.call<{trashEntryId: string}>(`/documents/${first.id}?expectedVersion=${live.version}`, 'DELETE');
  assert.equal(archived.status, 200, JSON.stringify(archived.data));
  assert.equal((await f.call(snapshotPath(earlier[0].id))).status, 404);
  const archivedBackup = await f.call<Backup>('/export');
  assert.equal(archivedBackup.status, 200);
  assert.equal((await portableImport(archivedBackup.data)).status, 200);
  assert.equal((await f.call(snapshotPath(earlier[0].id))).status, 404);
  const restored = await f.call(`/trash/${archived.data.trashEntryId}/restore`, 'POST');
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  await verifyLinks();
});

test('public publication routes require write access, enforce project boundaries and bind request/publish actors to API-key owners', async () => {
  const f = await fixture();
  try {
    const doc = await make(f);
    const otherResponse = await f.call<DocPage>('/documents', 'POST', { projectId: 'project-team', title: '다른 범위 합성 문서', content: content('외부 범위 원문') });
    assert.equal(otherResponse.status, 201);
    const createKey = async (access: 'read' | 'write', actor: string) => {
      const response = await f.call<ApiKeyCreated>('/api-keys', 'POST', { name: '합성 검토 API 키', access, projectIds: ['project-neo'], expiresAt: null }, actor);
      assert.equal(response.status, 201);
      return { Authorization: `Bearer ${response.data.token}` };
    };
    const read = await createKey('read', 'user-min');
    const requester = await createKey('write', 'user-min');
    const reviewer = await createKey('write', 'user-seo');
    const path = `/v1/documents/${doc.id}/publication`;
    const initial = await f.call<DocumentPublicationView>(path, 'GET', undefined, 'user-jun', read);
    assert.equal(initial.status, 200);
    const body = { action: 'request', expectedVersion: initial.data.version, workspaceGeneration: initial.data.workspaceGeneration, expectedDocumentVersion: doc.version, reviewerId: 'user-seo' };
    assert.equal((await f.call(path, 'POST', body, 'user-seo', read)).status, 403);
    assert.equal((await f.call(`/v1/documents/${otherResponse.data.id}/publication`, 'GET', undefined, 'user-min', requester)).status, 403);
    const requested = await f.call<DocumentPublicationView>(path, 'POST', body, 'user-jun', requester);
    assert.equal(requested.status, 200, JSON.stringify(requested.data));
    assert.equal(requested.data.review!.requestedById, 'user-min');
    const snapshotPath = `${path}/snapshot?kind=review&revisionId=${requested.data.review!.revisionId}`;
    assert.equal((await f.call<DocRevision>(snapshotPath, 'GET', undefined, 'user-jun', read)).data.plainText, doc.plainText);
    assert.equal((await f.call(`/v1/documents/${otherResponse.data.id}/publication/snapshot?kind=review&revisionId=${requested.data.review!.revisionId}`, 'GET', undefined, 'user-min', requester)).status, 403);
    const publish = { action: 'publish', expectedVersion: requested.data.version, workspaceGeneration: requested.data.workspaceGeneration };
    assert.equal((await f.call(path, 'POST', publish, 'user-seo', requester)).status, 403);
    const result = await f.call<DocumentPublicationView>(path, 'POST', publish, 'user-min', reviewer);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.published!.publishedById, 'user-seo');

    const comparePath = (view: DocumentPublicationView, documentId = doc.id) => `/v1/documents/${documentId}/publication/comparison?${new URLSearchParams({
      expectedVersion: String(view.version), workspaceGeneration: view.workspaceGeneration ?? '',
      publishedRevisionId: view.published!.revisionId, reviewRevisionId: view.review!.revisionId,
    })}`;
    const compareWithKey = (location: string) => f.call(location, 'GET', undefined, 'user-min', read);
    let current = await edit(f, doc, '같은 범위의 두 번째 검토 본문');
    const localPair = await requestReview(f, current);
    const comparison = await compareWithKey(comparePath(localPair));
    assert.equal(comparison.status, 200, JSON.stringify(comparison.data));
    assert.deepEqual(comparison.data, { version: localPair.version, workspaceGeneration: null,
      published: await snapshot(f, localPair, 'published'), review: await snapshot(f, localPair, 'review') });
    assert.equal((await compareWithKey(comparePath(localPair, otherResponse.data.id))).status, 403);
    assert.equal((await compareWithKey(`${comparePath(localPair)}&expectedVersion=${localPair.version}`)).status, 400);

    await accepted(transition(f, localPair, 'withdraw', 'user-min'));
    const withForeignReference = await f.call<DocPage>(`/documents/${doc.id}`, 'PATCH', {
      expectedVersion: current.version, content: {
        type: 'doc', content: [{ type: 'issueSummary', attrs: {
          projectId: 'project-team', savedViewId: null, label: '다른 프로젝트의 업무 현황', groupBy: 'status',
        } }],
      },
    });
    assert.equal(withForeignReference.status, 200, JSON.stringify(withForeignReference.data));
    const foreignReview = await requestReview(f, withForeignReference.data);
    assert.equal((await compareWithKey(comparePath(foreignReview))).status, 403);
    await accepted(transition(f, foreignReview, 'publish', 'user-seo'));
    current = await edit(f, withForeignReference.data, '다른 범위의 참조를 뺀 검토 본문');
    const foreignPublished = await requestReview(f, current);
    assert.equal((await compareWithKey(comparePath(foreignPublished))).status, 403);
  } finally { await f.close(); }
});
