import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { createApp } from '../../server/app.js';
import { COLLABORATION_SCHEMA, type CollaborationServerMessage, type CollaborationSession } from '../../shared/collaboration.js';
import {
  documentNotificationSpaceId, type ApiKeyCreated, type Comment, type DocPage, type DocRevision,
  type DocumentPublicationView, type DocumentTreeMovePreview, type Issue, type ResourceLink,
  type TeamNotificationPage, type TrashItemPage, type TrashPage, type TrashRestoreResult, type WorkspaceSnapshot,
} from '../../shared/types.js';

const sourceProject = 'project-neo';
const targetProject = 'project-team';
const actor = 'user-min';
const reviewer = 'user-seo';
const documentPath = (id: string) => `/documents/${id}`;

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-document-move-'));
  const runtime = createApp({ dataDir, outboundWorker: false });
  const server = runtime.app.listen(0, '127.0.0.1');
  runtime.attachWebSocket(server);
  t.after(async () => {
    try {
      runtime.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `127.0.0.1:${address.port}/api`;
  async function call<T = unknown>(path: string, method = 'GET', input?: unknown, status = 200, actorId = actor, token?: string) {
    const response = await fetch(`http://${origin}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actorId, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    const body = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${body}`);
    return JSON.parse(body) as T;
  }
  return {
    call, socketUrl: `ws://${origin}/collaboration`,
    add: (title: string, projectId: string | null, parentId: string | null = null) =>
      call<DocPage>('/documents', 'POST', { title, projectId, parentId,
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: title }] }] },
      }, 201),
    preview: (id: string, projectId: string | null, parentId: string | null = null, status = 200) =>
      call<DocumentTreeMovePreview>(`${documentPath(id)}/move-preview`, 'POST', { projectId, parentId }, status),
    move: (preview: DocumentTreeMovePreview, status = 200) => {
      const { documentId, projectId, parentId, token } = preview;
      return call<DocumentTreeMovePreview>(`${documentPath(documentId)}/move`, 'POST', { projectId, parentId, token }, status);
    },
    archive: (document: DocPage) => call<{ trashEntryId: string }>(documentPath(document.id), 'DELETE', { expectedVersion: document.version }),
    workspace: () => call<WorkspaceSnapshot>('/workspace'),
  };
}

test('moving a subtree transfers active documents, preserves revision and issue links, and scopes reads and notifications to the destination', async t => {
  const f = await fixture(t);
  const source = await f.add('기존 상위 문서', sourceProject);
  const root = await f.add('이동할 문서', sourceProject, source.id);
  const child = await f.add('하위 문서', sourceProject, root.id);
  const grandchild = await f.add('손자 문서', sourceProject, child.id);
  const destination = await f.add('이동 목적지', targetProject);
  const issue = await f.call<Issue>('/issues', 'POST', { title: '연결 업무', projectId: sourceProject }, 201);
  const link = await f.call<ResourceLink>('/resource-links', 'POST', { issueId: issue.id, documentId: child.id }, 201);
  const revision = (await f.call<DocRevision[]>(`${documentPath(child.id)}/revisions`))[0];
  const publicationPath = `${documentPath(child.id)}/publication`;
  const initial = await f.call<DocumentPublicationView>(publicationPath);
  const request = await f.call<DocumentPublicationView>(publicationPath, 'POST', {
    action: 'request', expectedVersion: initial.version, workspaceGeneration: initial.workspaceGeneration,
    expectedDocumentVersion: child.version, reviewerId: reviewer,
  });
  const published = await f.call<DocumentPublicationView>(publicationPath, 'POST', {
    action: 'publish', expectedVersion: request.version, workspaceGeneration: request.workspaceGeneration,
  }, 200, reviewer);
  const oldScopeKey = await f.call<ApiKeyCreated>('/api-keys', 'POST', { name: '출발 문서 범위', access: 'read', projectIds: [sourceProject] }, 201);
  const newScopeKey = await f.call<ApiKeyCreated>('/api-keys', 'POST', { name: '도착 문서 범위', access: 'write', projectIds: [targetProject] }, 201);
  await f.call(`/notifications/subscriptions/space/${documentNotificationSpaceId(targetProject)}`, 'PUT', { subscribed: true }, 200, reviewer);

  const preview = await f.preview(root.id, targetProject, destination.id);
  assert.equal(preview.changed, true);
  assert.equal(preview.archivedCount, 0);
  assert.equal(preview.sourceParentId, source.id);
  assert.deepEqual(preview.documents, [root, child, grandchild].map(({ id, title }) => ({ id, title })));
  await f.call(`/v1${documentPath(root.id)}/move-preview`, 'POST', { projectId: targetProject, parentId: destination.id }, 403, actor, newScopeKey.token);
  assert.deepEqual(await f.move(preview), preview);

  const after = await f.workspace();
  for (const original of [root, child, grandchild]) {
    const current = after.documents.find(document => document.id === original.id)!;
    const { updatedAt } = current;
    assert.deepEqual(current, { ...original, updatedAt, version: original.version + 1, projectId: targetProject,
      parentId: original.id === root.id ? destination.id : original.parentId });
    assert.equal(after.activities.filter(activity => activity.resourceId === original.id && activity.action === '문서 이동').length, 1);
  }
  assert.deepEqual(after.resourceLinks.find(value => value.id === link.id), link);
  const revisions = await f.call<DocRevision[]>(`${documentPath(child.id)}/revisions`);
  assert.deepEqual(revisions.find(value => value.id === revision.id), revision);
  assert.equal(revisions[0].summary, '문서 이동');
  const snapshotPath = `${publicationPath}/snapshot?kind=published&revisionId=${published.published!.revisionId}`;
  assert.deepEqual(await f.call(`/v1${snapshotPath}`, 'GET', undefined, 200, actor, newScopeKey.token), revision);
  await f.call(`/v1${snapshotPath}`, 'GET', undefined, 403, actor, oldScopeKey.token);
  assert.deepEqual(await f.call('/v1' + documentPath(child.id), 'GET', undefined, 200, actor, newScopeKey.token), after.documents.find(value => value.id === child.id));
  await f.call('/v1' + documentPath(child.id), 'GET', undefined, 403, actor, oldScopeKey.token);
  const inbox = await f.call<TeamNotificationPage>('/notifications', 'GET', undefined, 200, reviewer);
  assert.deepEqual(new Set(inbox.items.filter(item => item.kind === 'document-updated' && item.projectId === targetProject).map(item => item.targetId)),
    new Set([root.id, child.id, grandchild.id]));
});

test('stale subtree and destination checks prevent partial moves, and same-space and no-op moves update only the selected document', async t => {
  const f = await fixture(t);
  const root = await f.add('시작 문서', sourceProject);
  const destination = await f.add('목적지 문서', sourceProject);
  const path = documentPath(root.id);
  await f.call(`${path}/move-preview`, 'POST', [], 400);
  await f.call(`${path}/move-preview`, 'POST', null, 400);
  await f.call(`${path}/move-preview`, 'POST', { projectId: sourceProject }, 400);
  await f.call(`${path}/move`, 'POST', { projectId: sourceProject, parentId: null }, 400);
  await f.preview(root.id, sourceProject, root.id, 409);
  await f.preview(root.id, targetProject, destination.id, 409);
  await f.preview(root.id, sourceProject, randomUUID(), 404);

  const staleMembership = await f.preview(root.id, sourceProject, destination.id);
  const child = await f.add('미리보기 이후 생성한 하위 문서', sourceProject, root.id);
  await f.preview(root.id, sourceProject, child.id, 409);
  await f.move(staleMembership, 409);
  const staleDestination = await f.preview(root.id, sourceProject, destination.id);
  await f.call(documentPath(destination.id), 'PATCH', { expectedVersion: destination.version, title: '목적지 새 제목' });
  await f.move(staleDestination, 409);
  const staleChild = await f.preview(root.id, sourceProject, destination.id);
  const newerChild = await f.call<DocPage>(documentPath(child.id), 'PATCH', { expectedVersion: child.version, title: '새 하위 문서 제목' });
  await f.move(staleChild, 409);
  const unchanged = (await f.workspace()).documents.find(document => document.id === root.id);
  assert.deepEqual(unchanged, root);

  const preview = await f.preview(root.id, sourceProject, destination.id);
  assert.deepEqual(preview.documents.map(document => document.id), [root.id, child.id]);
  await f.move(preview);
  await f.move(preview, 409);
  const noOp = await f.preview(root.id, sourceProject, destination.id);
  assert.equal(noOp.changed, false);
  await f.move(noOp);
  const after = await f.workspace();
  assert.equal(after.documents.find(document => document.id === root.id)?.version, root.version + 1);
  assert.equal(after.documents.find(document => document.id === root.id)?.parentId, destination.id);
  assert.deepEqual(after.documents.find(document => document.id === child.id), newerChild);
  assert.equal(after.activities.filter(activity => activity.resourceId === root.id && activity.action === '문서 이동').length, 1);
});

test('a cross-space move includes archived branches and restores them from a backup in their new scope', async t => {
  const f = await fixture(t);
  const root = await f.add('이동할 문서', sourceProject);
  const hidden = await f.add('휴지통의 상위 문서', sourceProject, root.id);
  const nested = await f.add('휴지통의 하위 문서', sourceProject, hidden.id);
  const nestedEntry = await f.archive(nested);
  const hiddenEntry = await f.archive(hidden);
  const movedLegacy = await f.call<DocPage>(documentPath(root.id), 'PATCH', { expectedVersion: root.version, projectId: targetProject });
  const child = await f.add('활성 하위 문서', targetProject, root.id);
  const archivedUnderChild = await f.add('활성 문서 아래 휴지통 문서', targetProject, child.id);
  const beforeArchive = await f.preview(movedLegacy.id, null);
  const thirdEntry = await f.archive(archivedUnderChild);
  await f.move(beforeArchive, 409);
  const note = await f.call<Comment>('/comments', 'POST', { resourceType: 'document', resourceId: child.id, body: '개별로 삭제한 댓글' }, 201);
  await f.call(`/comments/${note.id}`, 'DELETE');

  const preview = await f.preview(movedLegacy.id, null);
  assert.equal(preview.archivedCount, 3);
  await f.move(preview);
  const common = await f.call<TrashPage>('/trash?scope=common');
  assert.deepEqual(new Set(common.items.map(item => item.resourceId)), new Set([hidden.id, nested.id, archivedUnderChild.id]));
  assert.equal((await f.call<TrashPage>(`/trash?scope=project&projectId=${sourceProject}`)).total, 0);
  assert.equal((await f.call<TrashItemPage>('/trash/items?scope=common')).items[0].ownerId, child.id);
  assert.equal((await f.workspace()).documents.find(document => document.id === child.id)?.version, child.version + 1);
  await f.call('/import', 'POST', { data: await f.call('/export') });

  const nestedRestore = `/trash/${nestedEntry.trashEntryId}/restore`;
  await f.call(nestedRestore, 'POST', {}, 409);
  assert.equal((await f.call<TrashRestoreResult>(`/trash/${hiddenEntry.trashEntryId}/restore`, 'POST', {})).projectId, null);
  assert.equal((await f.call<TrashRestoreResult>(nestedRestore, 'POST', {})).projectId, null);
  const docs = (await f.workspace()).documents;
  assert.equal(docs.find(document => document.id === nested.id)?.parentId, hidden.id);
  assert.equal(docs.find(document => document.id === hidden.id)?.parentId, root.id);
  const back = await f.preview(root.id, sourceProject);
  assert.equal(back.archivedCount, 1);
  await f.move(back);
  assert.equal((await f.call<TrashRestoreResult>(`/trash/${thirdEntry.trashEntryId}/restore`, 'POST', {})).projectId, sourceProject);
});

function socketMessage<T extends CollaborationServerMessage['type']>(socket: WebSocket, type: T) {
  return new Promise<Extract<CollaborationServerMessage, { type: T }>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('message', receive);
      reject(new Error(`Waiting for collaboration message ${type} timed out`));
    }, 5000);
    function receive(raw: Buffer) {
      const message = JSON.parse(raw.toString()) as CollaborationServerMessage;
      if (message.type !== type) return;
      clearTimeout(timeout);
      socket.off('message', receive);
      resolve(message as Extract<CollaborationServerMessage, { type: T }>);
    }
    socket.on('message', receive);
  });
}

test('a moved document broadcasts its new metadata to existing peers and keeps accepting updates in the same room', async t => {
  const f = await fixture(t);
  const root = await f.add('공동 편집 상위 문서', sourceProject);
  const child = await f.add('공동 편집 본문', sourceProject, root.id);
  const path = documentPath(child.id);
  const session = await f.call<CollaborationSession>(`${path}/collaboration/enable`, 'POST', { expectedVersion: child.version });
  const socket = new WebSocket(`${f.socketUrl}?${new URLSearchParams({ documentId: child.id, actorId: reviewer })}`);
  const ydoc = new Y.Doc();
  try {
    await once(socket, 'open', { signal: AbortSignal.timeout(5000) });
    const welcomed = socketMessage(socket, 'welcome');
    socket.send(JSON.stringify({ type: 'hello', schemaVersion: COLLABORATION_SCHEMA, epoch: session.epoch }));
    const welcome = await welcomed;
    Y.applyUpdate(ydoc, Buffer.from(welcome.update, 'base64'));
    const original = Y.encodeStateVector(ydoc);
    const newText = new Y.XmlText();
    newText.insert(0, '같은 방에서 이어서 작성');
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [newText]);
    ydoc.getXmlFragment('default').push([paragraph]);
    const pendingUpdate = Buffer.from(Y.encodeStateAsUpdate(ydoc, original)).toString('base64');

    const preview = await f.preview(root.id, targetProject);
    const notified = socketMessage(socket, 'update');
    await f.move(preview);
    const metadata = await notified;
    assert.equal(metadata.epoch, welcome.epoch);
    assert.deepEqual(metadata.document.content, session.document.content);
    assert.equal(metadata.document.projectId, targetProject);
    assert.equal(metadata.document.version, session.document.version + 1);
    const acked = socketMessage(socket, 'ack');
    socket.send(JSON.stringify({ type: 'update', epoch: welcome.epoch, requestId: randomUUID(), update: pendingUpdate }));
    const ack = await acked;
    assert.equal(ack.epoch, welcome.epoch);
    assert.equal(ack.document.projectId, targetProject);
    assert.equal(ack.document.version, metadata.document.version + 1);
    assert.match(ack.document.plainText, /같은 방에서 이어서 작성/);
  } finally {
    socket.terminate();
    ydoc.destroy();
  }
});
