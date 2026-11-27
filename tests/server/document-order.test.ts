import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type { DocPage, DocRevision, DocumentSiblingOrder, DocumentTreeCopyPreview, DocumentTreeMovePreview, WorkspaceSnapshot } from '../../shared/types.js';

const sourceProject = 'project-neo';
const targetProject = 'project-team';
const path = (document: DocPage) => `/documents/${document.id}`;
const orderPath = (document: DocPage) => `${path(document)}/sibling-order`;
type Backup = WorkspaceSnapshot & { schemaVersion: number; documentOrders: DocumentSiblingOrder[] };
type OrderFailure = { details: { reason: string } };

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'donefac-order-http-'));
  const runtime = createApp({ dataDir, outboundWorker: false });
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}/api`;
  t.after(async () => {
    try {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      runtime.close();
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });
  async function call<T>(route: string, status = 200, method = 'GET', input?: unknown, actor = 'user-min') {
    const response = await fetch(origin + route, {
      method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actor },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const body = await response.text();
    assert.equal(response.status, status, `${method} ${route}: ${body}`);
    return JSON.parse(body) as T;
  }
  const add = (title: string, projectId: string | null = sourceProject, parentId: string | null = null) =>
    call<DocPage>('/documents', 201, 'POST', { title, projectId, parentId });
  const getOrder = (document: DocPage) => call<DocumentSiblingOrder>(orderPath(document));
  const workspace = () => call<WorkspaceSnapshot>('/workspace');
  const document = async (id: string) => (await workspace()).documents.find(page => page.id === id)!;
  const saveOrder = <T = DocumentSiblingOrder>(document: DocPage, expectedVersion: string, documentIds: string[], status = 200, actor?: string) =>
    call<T>(orderPath(document), status, 'PATCH', { expectedVersion, documentIds }, actor);
  async function move(document: DocPage, projectId: string | null, parentId: string | null) {
    const preview = await call<DocumentTreeMovePreview>(`${path(document)}/move-preview`, 200, 'POST', { projectId, parentId });
    await call(`${path(document)}/move`, 200, 'POST', { projectId, parentId, token: preview.token });
  }
  return { call, add, getOrder, saveOrder, move, workspace, document };
}

test('a sibling order survives content edits and cross-space moves, appends restored pages, and roundtrips with format 82', async t => {
  const f = await fixture(t);
  const parent = await f.add('정렬할 문서 묶음');
  const earlier = await f.add('먼저 만든 이동할 문서');
  const a = await f.add('가 문서', sourceProject, parent.id);
  const b = await f.add('나 문서', sourceProject, parent.id);
  const c = await f.add('다 문서', sourceProject, parent.id);
  const destination = await f.add('다른 공간 상위 문서', targetProject);
  const originalDestinationChild = await f.add('기존 도착 문서', targetProject, destination.id);
  const common = await f.add('팀 공통의 최상위 문서', null);
  const initial = await f.getOrder(a);
  const revisions = await f.call<DocRevision[]>(`${path(a)}/revisions`);
  assert.deepEqual(initial.documentIds, [a.id, b.id, c.id]);
  const commonScope = await f.getOrder(common);
  assert.ok(commonScope.documentIds.includes(common.id));
  assert.ok(!commonScope.documentIds.includes(parent.id));
  assert.equal(commonScope.projectId, null);
  const wrong = await f.saveOrder<OrderFailure>(a, initial.version, [c.id, destination.id, a.id], 409);
  assert.equal(wrong.details.reason, 'document_order_membership_changed');
  await f.saveOrder(a, initial.version, [a.id, a.id, c.id], 400);

  const reviewed = await f.saveOrder(a, initial.version, [c.id, a.id, b.id], 200, 'user-seo');
  assert.notEqual(reviewed.version, initial.version);
  const stale = await f.saveOrder<OrderFailure>(b, initial.version, [b.id, c.id, a.id], 409);
  assert.equal(stale.details.reason, 'document_order_stale');
  assert.deepEqual(await f.document(a.id), a);
  assert.deepEqual(await f.call(`${path(a)}/revisions`), revisions);
  assert.deepEqual(await f.saveOrder(b, reviewed.version, reviewed.documentIds), reviewed);
  const workspace = await f.workspace();
  assert.deepEqual(workspace.documentOrders?.find(order => order.parentId === parent.id), { ...reviewed, custom: true });
  const audit = workspace.activities.filter(activity => activity.action === '문서 순서 변경' && activity.resourceId === a.id);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actorId, 'user-seo');
  const edited = await f.call<DocPage>(path(a), 200, 'PATCH', { expectedVersion: a.version, title: '제목 편집한 문서' });
  assert.notEqual(edited.version, a.version);
  assert.deepEqual(await f.getOrder(a), reviewed);

  await f.move(earlier, targetProject, destination.id);
  assert.deepEqual((await f.getOrder(originalDestinationChild)).documentIds, [originalDestinationChild.id, earlier.id]);
  await f.move(parent, targetProject, destination.id);
  const moved = await f.getOrder(b);
  assert.deepEqual([moved.projectId, moved.parentId, moved.documentIds], [targetProject, parent.id, reviewed.documentIds]);
  assert.notEqual(moved.version, reviewed.version);
  assert.deepEqual((await f.getOrder(parent)).documentIds, [originalDestinationChild.id, earlier.id, parent.id]);
  const current = await f.document(a.id);
  const { trashEntryId } = await f.call<{ trashEntryId: string }>(`${path(a)}?expectedVersion=${current.version}`, 200, 'DELETE');
  const pruned = await f.getOrder(b);
  assert.deepEqual(pruned.documentIds, [c.id, b.id]);
  await f.call(`/trash/${trashEntryId}/restore`, 200, 'POST', {});
  const restored = await f.getOrder(a);
  assert.deepEqual(restored.documentIds, [c.id, b.id, a.id]);
  assert.notEqual(restored.version, moved.version);

  const backup = await f.call<Backup>('/export');
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.deepEqual(backup.documentOrders.find(order => order.parentId === parent.id)?.documentIds, restored.documentIds);
  assert.ok(backup.documentOrders.every(order => order.projectId === targetProject));
  const bad = backup.documentOrders.map(order => order.parentId === parent.id
    ? { ...order, documentIds: [c.id, b.id, common.id] } : order);
  await f.call('/import', 400, 'POST', { data: { ...backup, documentOrders: bad } });
  await f.call('/import', 400, 'POST', { data: { ...backup, schemaVersion: 81 } });
  assert.deepEqual(await f.getOrder(a), restored);
  await f.call('/import', 200, 'POST', { data: backup });
  const roundtrip = await f.getOrder(b);
  assert.deepEqual(roundtrip.documentIds, restored.documentIds);
  assert.notEqual(roundtrip.version, restored.version);
  await f.call('/import', 200, 'POST', { data: { ...backup, schemaVersion: 81, documentOrders: [] } });
  assert.deepEqual((await f.getOrder(a)).documentIds,
    backup.documents.filter(document => document.parentId === parent.id).map(document => document.id));
});

test('copy preview is fenced by sibling order and the saved subtree copies the visible peer order', async t => {
  const f = await fixture(t);
  const parent = await f.add('순서를 복제할 문서');
  const a = await f.add('첫째로 쓴 문서', sourceProject, parent.id);
  const b = await f.add('둘째로 쓴 문서', sourceProject, parent.id);
  const c = await f.add('셋째로 쓴 문서', sourceProject, parent.id);
  const options = { title: '순서를 반영한 사본', projectId: targetProject, parentId: null,
    includeDescendants: true, expectedSourceVersion: parent.version };
  const previewPath = `${path(parent)}/copy-preview`;
  const copyPath = `${path(parent)}/copy`;
  const before = await f.call<DocumentTreeCopyPreview>(previewPath, 200, 'POST', options);
  assert.deepEqual(before.documents.map(page => page.id), [parent.id, a.id, b.id, c.id]);
  const current = await f.getOrder(a);
  await f.saveOrder(a, current.version, [c.id, a.id, b.id]);
  const stale = await f.call<{ details: { reason: string } }>(copyPath, 409, 'POST', {
    ...options, token: before.token, requestId: randomUUID(),
  });
  assert.equal(stale.details.reason, 'copy_preview_stale');
  const after = await f.call<DocumentTreeCopyPreview>(previewPath, 200, 'POST', options);
  assert.deepEqual(after.documents.map(page => page.id), [parent.id, c.id, a.id, b.id]);
  const copy = await f.call<DocPage>(copyPath, 201, 'POST', { ...options, token: after.token, requestId: randomUUID() });
  const workspace = await f.workspace();
  const children = workspace.documents.filter(page => page.parentId === copy.id);
  assert.deepEqual(children.map(page => page.title), [c.title, a.title, b.title]);
  const copiedOrder = await f.getOrder(children[0]);
  assert.deepEqual(copiedOrder.documentIds, children.map(page => page.id));
  assert.deepEqual(workspace.documentOrders?.find(order => order.parentId === copy.id), { ...copiedOrder, custom: true });
  const backup = await f.call<Backup>('/export');
  assert.deepEqual(backup.documentOrders.find(order => order.parentId === copy.id), copiedOrder);
  await f.call('/import', 200, 'POST', { data: backup });
  const restored = (await f.workspace()).documentOrders?.find(order => order.parentId === copy.id);
  assert.equal(restored?.custom, true);
  assert.deepEqual(restored?.documentIds, copiedOrder.documentIds);
});
