import assert from 'node:assert/strict';
import { on, once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { createApp } from '../../server/app.js';
import { COLLABORATION_SCHEMA, type CollaborationServerMessage, type CollaborationSession } from '../../shared/collaboration.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type { DocPage, DocRevision, DocumentSiblingOrder, LegacyPackageSummary, MigrationApplyResult, MigrationConfiguration,
  MigrationOptions, MigrationPreview, WorkspaceSnapshot } from '../../shared/types.js';
import { zip } from '../fixtures/legacy-export-zip.mjs';

async function workspace(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teamspace-confluence-hierarchy-'));
  const runtime = createApp({ dataDir: directory, outboundWorker: false });
  const server = runtime.app.listen(0, '127.0.0.1');
  runtime.attachWebSocket(server);
  const sockets = new Set<WebSocket>();
  const db = new DatabaseSync(join(directory, 'teamspace.sqlite'));
  db.exec('PRAGMA busy_timeout=5000');
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    runtime.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  const request = async <T>(path: string, status = 200, method = 'GET', body?: unknown) => {
    const response = await fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': 'user-seo' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${data}`);
    return JSON.parse(data) as T;
  };
  const reference = (name: string, type: string, id: number) =>
    `<property name="${name}" class="${type}"><id name="id">${id}</id></property>`;
  async function upload(name: string, version: number, pages: readonly [id: number, parentId: number | null, position?: number | string][],
    instanceKey = 'confluence-hierarchy-apply') {
    const space = '<object class="Space"><id name="id">42</id><property name="key">HIER</property><property name="name">Hierarchy source</property></object>';
    const objects = pages.map(([id, parent, position]) => `<object class="Page"><id name="id">${id}</id>
      <property name="title">Page ${id}</property><property name="version">${version}</property>
      <property name="creationDate">2020-05-01T00:00:00Z</property>
      <property name="lastModificationDate">2020-05-0${version + 1}T00:00:00Z</property>
      ${reference('space', 'Space', 42)}${parent === null ? '<property name="parent"/>' : reference('parent', 'Page', parent)}
      ${position === undefined ? '' : `<property name="position">${position}</property>`}
      </object><object class="BodyContent"><id name="id">${id + 1000}</id>
      <property name="body"><![CDATA[<p>Body ${id}</p>]]></property>${reference('content', 'Page', id)}</object>`).join('');
    const archive = zip([{ path: 'entities.xml', bytes: Buffer.from(`<hibernate-generic>${space}${objects}</hibernate-generic>`) }]);
    const query = new URLSearchParams({ filename: `${name}.zip`, product: 'confluence', instanceKey });
    const response = await fetch(`${base}/legacy-import/packages?${query}`, { method: 'POST', body: new Uint8Array(archive),
      headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': 'user-seo' } });
    const data = await response.text();
    assert.equal(response.status, 201, data);
    const { id } = JSON.parse(data) as LegacyPackageSummary;
    return (await request<MigrationOptions>(`/migrations/options?packageId=${id}`)).defaultConfiguration;
  }
  const preview = (configuration: MigrationConfiguration) => request<MigrationPreview>('/migrations/preview', 201, 'POST', { configuration });
  const apply = (value: MigrationPreview, status = 201) => request<MigrationApplyResult>(`/migrations/previews/${value.id}/apply`, status, 'POST', {
    expectedVersion: value.version, acknowledgements: value.requiredAcknowledgements,
  });
  const docs = async () => (await request<WorkspaceSnapshot>('/workspace')).documents;
  async function connect(documentId: string, epoch: string | null) {
    const query = new URLSearchParams({ documentId, actorId: 'user-min' });
    const socket = new WebSocket(`${base.replace('http:', 'ws:')}/collaboration?${query}`);
    sockets.add(socket);
    await once(socket, 'open');
    const message = once(socket, 'message', { signal: AbortSignal.timeout(6000) });
    socket.send(JSON.stringify({ type: 'hello', epoch, schemaVersion: COLLABORATION_SCHEMA }));
    const [bytes] = await message;
    assert.equal((JSON.parse(String(bytes)) as CollaborationServerMessage).type, 'welcome');
    return socket;
  }
  return { db, request, upload, preview, apply, docs, connect };
}

function importedPage(documents: readonly DocPage[], projectId: string, sourceId: number): DocPage {
  const title = `Page ${sourceId}`;
  const page = documents.find(document => document.projectId === projectId && document.title === title);
  assert.ok(page, title);
  return page;
}

const orderPath = (document: DocPage) => `/documents/${document.id}/sibling-order`;

test('Confluence root and nested sibling positions apply atomically and survive the native backup roundtrip', async t => {
  const f = await workspace(t);
  const source = await f.upload('native-sibling-order', 1, [
    [100, null, 10], [200, 100, 10], [300, 100, 0], [400, 100, 2], [500, null, 2],
  ]);
  const plan = await f.preview(source);
  assert.equal(plan.canApply, true, JSON.stringify(plan.notices));
  assert.equal(plan.counts.confluenceOrderedSiblingGroups, 2);
  assert.equal(plan.counts.confluenceUnresolvedSiblingGroups, undefined);
  const before = await f.request<WorkspaceSnapshot>('/workspace');
  f.db.exec(`CREATE TRIGGER fail_confluence_order_receipt BEFORE INSERT ON source_imports
    BEGIN SELECT RAISE(ABORT, 'synthetic document order receipt failure'); END`);
  try { await f.apply(plan, 500); }
  finally { f.db.exec('DROP TRIGGER fail_confluence_order_receipt'); }
  assert.deepEqual(await f.request<WorkspaceSnapshot>('/workspace'), before);

  const { import: receipt } = await f.apply(plan);
  const [projectId] = receipt.projectIds;
  assert.equal(receipt.counts.confluenceOrderedSiblingGroups, 2);
  const snapshot = await f.request<WorkspaceSnapshot>('/workspace');
  const page = (id: number) => importedPage(snapshot.documents, projectId, id);
  const expected = [{ leader: page(100), parentId: null, ids: [page(500).id, page(100).id] },
    { leader: page(200), parentId: page(100).id, ids: [page(300).id, page(400).id, page(200).id] }];
  for (const { leader, parentId, ids } of expected) {
    const order = await f.request<DocumentSiblingOrder>(orderPath(leader));
    assert.deepEqual([order.projectId, order.parentId, order.documentIds], [projectId, parentId, ids]);
    assert.deepEqual(snapshot.documentOrders?.find(group => group.projectId === projectId && group.parentId === parentId), { ...order, custom: true });
  }
  assert.equal((await f.apply(plan, 200)).duplicate, true);
  assert.deepEqual((await f.request<WorkspaceSnapshot>('/workspace')).documentOrders, snapshot.documentOrders);

  const backup = await f.request<WorkspaceSnapshot & { schemaVersion: number }>('/export');
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.deepEqual(backup.documentOrders?.filter(group => group.projectId === projectId).map(group => [group.parentId, group.documentIds]),
    expected.map(({ parentId, ids }) => [parentId, ids]));
  await f.request('/import', 200, 'POST', { data: backup });
  for (const { leader, ids } of expected) {
    assert.deepEqual((await f.request<DocumentSiblingOrder>(orderPath(leader))).documentIds, ids);
  }
});

test('Confluence sibling groups keep their baseline when positions are missing, invalid or repeated', async t => {
  const f = await workspace(t);
  const source = await f.upload('ambiguous-sibling-order', 1, [
    [100, null], [200, 100, 2], [300, 100, 2],
    [500, null], [501, 500, 10], [502, 500],
    [600, null], [601, 600, '1.5'], [602, 600, 1],
    [700, null], [701, 700], [702, 700, -1],
    [900, null], [901, 900, 10], [902, 900, 2], [903, 900, 2],
  ]);
  const plan = await f.preview({ ...source, excludedRecords: [`${source.packageIds[0]}/page:903`] });
  assert.equal(plan.canApply, true, JSON.stringify(plan.notices));
  assert.equal(plan.counts.confluenceOrderedSiblingGroups, 1);
  assert.equal(plan.counts.confluenceUnresolvedSiblingGroups, 3);
  const unresolved = plan.notices.filter(notice => notice.code === 'CONFLUENCE_SIBLING_ORDER_UNRESOLVED');
  assert.ok(unresolved.length > 0);
  assert.ok(unresolved.every(notice => notice.severity === 'warning' && !notice.requiresAcknowledgement));
  const [projectId] = (await f.apply(plan)).import.projectIds;
  const documents = await f.docs();
  const page = (id: number) => importedPage(documents, projectId, id);
  assert.ok(!documents.some(document => document.projectId === projectId && document.title === 'Page 903'));
  for (const [leader, ...siblings] of [[200, 300], [501, 502], [601, 602], [701, 702], [902, 901]]) {
    assert.deepEqual((await f.request<DocumentSiblingOrder>(orderPath(page(leader)))).documentIds, [leader, ...siblings].map(id => page(id).id));
  }
});

test('Confluence roots from different source instances cannot establish one sibling order', async t => {
  const f = await workspace(t);
  const one = await f.upload('sibling-instance-one', 1, [[100, null, 10], [200, null, 2]], 'confluence-one');
  const two = await f.upload('sibling-instance-two', 1, [[300, null, 9], [400, null, 1]], 'confluence-two');
  const query = new URLSearchParams([...one.packageIds, ...two.packageIds].map(id => ['packageId', id]));
  const { defaultConfiguration } = await f.request<MigrationOptions>(`/migrations/options?${query}`);
  const projects = defaultConfiguration.projects.map(project => ({ ...project, key: 'SHARED', name: 'Merged Confluence spaces' }));
  const plan = await f.preview({ ...defaultConfiguration, projects });
  assert.equal(plan.canApply, true, JSON.stringify(plan.notices));
  assert.equal(plan.counts.confluenceOrderedSiblingGroups, undefined);
  assert.equal(plan.counts.confluenceUnresolvedSiblingGroups, 1);
  const [projectId] = (await f.apply(plan)).import.projectIds;
  const documents = (await f.docs()).filter(document => document.projectId === projectId);
  assert.equal(documents.length, 4);
  assert.deepEqual((await f.request<DocumentSiblingOrder>(orderPath(documents[0]))).documentIds, documents.map(document => document.id));
});

test('Confluence append preserves existing page order and seeds siblings of a newly imported parent', async t => {
  const f = await workspace(t);
  const source = await f.upload('sibling-order-original', 1, [[100, null, 1], [110, 100, 1], [120, 100, 2], [200, null, 2]]);
  const first = await f.preview(source);
  const [projectId] = (await f.apply(first)).import.projectIds;
  const initial = await f.docs();
  const prior = (id: number) => importedPage(initial, projectId, id);
  const initialOrders = (await f.request<WorkspaceSnapshot>('/workspace')).documentOrders;
  const order = initialOrders?.find(group => group.projectId === projectId && group.parentId === null);
  assert.equal(order?.custom, true);
  assert.deepEqual(order?.documentIds, [prior(100).id, prior(200).id]);
  async function reorder(leader: number, ...ordered: number[]) {
    const path = orderPath(prior(leader));
    const { version: expectedVersion } = await f.request<DocumentSiblingOrder>(path);
    return f.request<DocumentSiblingOrder>(path, 200, 'PATCH', { expectedVersion, documentIds: ordered.map(id => prior(id).id) });
  }
  await reorder(100, 200, 100);
  await reorder(110, 120, 110);

  const incoming = await f.upload('sibling-order-append', 2, [
    [100, null, 1], [110, 100, 1], [120, 100, 2], [130, 100, 0], [200, null, 2],
    [500, null, 0], [510, 500, 9], [520, 500, 1],
  ]);
  const plan = await f.preview({ ...incoming, appendPagesTo: { projectId } });
  assert.equal(plan.canApply, true, JSON.stringify(plan.notices));
  assert.equal(plan.counts.documents, 4);
  assert.equal(plan.counts.confluenceOrderedSiblingGroups, 1);
  await f.apply(plan);
  const documents = await f.docs();
  const page = (id: number) => importedPage(documents, projectId, id);
  for (const [leader, ...siblings] of [[200, 100, 500], [120, 110, 130], [520, 510]]) {
    assert.deepEqual((await f.request<DocumentSiblingOrder>(orderPath(page(leader)))).documentIds, [leader, ...siblings].map(id => page(id).id));
  }
});

async function nextCollaborationChange(socket: WebSocket) {
  for await (const [bytes] of on(socket, 'message', { signal: AbortSignal.timeout(6000) })) {
    const message = JSON.parse(String(bytes)) as CollaborationServerMessage;
    if (message.type === 'update' || message.type === 'reset') return message;
  }
  throw new Error('Expected a collaborative hierarchy update.');
}

test('Confluence parent updates validate and commit the projected tree with document order and active collaboration', async t => {
  const f = await workspace(t);
  const source = await f.upload('hierarchy-initial', 1, [[100, null], [200, 100], [300, 200], [400, 100], [500, 100]]);
  const initial = await f.preview(source);
  assert.equal(initial.canApply, true, JSON.stringify(initial.notices));
  const [projectId] = (await f.apply(initial)).import.projectIds;
  const append = (configuration: MigrationConfiguration) => f.preview({ ...configuration, appendPagesTo: { projectId, refreshExisting: true } });
  const fromTitle = (documents: DocPage[], title: string) => {
    const result = documents.find(document => document.projectId === projectId && document.title === title);
    assert.ok(result, title);
    return result;
  };
  const original = await f.docs();
  const originalRoot = fromTitle(original, 'Page 100');
  const root = await f.request<DocPage>(`/documents/${originalRoot.id}`, 200, 'PATCH', {
    expectedVersion: originalRoot.version, title: '긴 제목으로 공유하는 상위 문서'.padEnd(300, '가'),
  });
  const a = fromTitle(original, 'Page 200');
  const b = fromTitle(original, 'Page 300');
  const destination = fromTitle(original, 'Page 400');
  const beside = fromTitle(original, 'Page 500');
  assert.equal(a.parentId, root.id);
  assert.equal(b.parentId, a.id);

  const order = (document: DocPage) => f.request<DocumentSiblingOrder>(orderPath(document));
  async function reorder(document: DocPage, documentIds: string[]) {
    const { version: expectedVersion } = await order(document);
    return f.request<DocumentSiblingOrder>(orderPath(document), 200, 'PATCH', { expectedVersion, documentIds });
  }
  const add = (title: string, parentId: string) => f.request<DocPage>('/documents', 201, 'POST', { title, projectId, parentId });
  const first = await add('Local destination first', destination.id);
  const second = await add('Local destination second', destination.id);
  const formerFirst = await add('Local source first', root.id);
  const formerSecond = await add('Local source second', root.id);
  const oldOrder = await reorder(a, [formerSecond.id, beside.id, a.id, destination.id, formerFirst.id]);
  const newOrder = await reorder(first, [second.id, first.id]);

  const cyclicSource = await f.upload('hierarchy-cycle', 2, [[200, 300]]);
  const cyclic = await append(cyclicSource);
  assert.equal(cyclic.canApply, false);
  assert.ok(cyclic.notices.some(notice => notice.severity === 'error' && notice.message.includes('순환')));
  await f.apply(cyclic, 409);
  assert.deepEqual(await order(a), oldOrder);
  assert.deepEqual(await order(first), newOrder);

  const sessionPath = `/documents/${a.id}/collaboration`;
  const session = await f.request<CollaborationSession>(`${sessionPath}/enable`, 200, 'POST', { expectedVersion: a.version });
  const peer = await f.connect(a.id, session.epoch);
  const validSource = await f.upload('hierarchy-projection', 2, [[200, 300], [300, 400], [500, 600], [600, 200]]);
  const stale = await append(validSource);
  assert.equal(stale.canApply, true, JSON.stringify(stale.notices));
  const renamed = await f.request<DocPage>(`/documents/${destination.id}`, 200, 'PATCH', {
    expectedVersion: destination.version, title: 'Local destination title',
  });
  assert.equal(renamed.parentId, root.id);
  await f.apply(stale, 409);
  const fresh = await append(validSource);
  assert.equal(fresh.canApply, true, JSON.stringify(fresh.notices));
  assert.equal(fresh.counts.documents, 1);
  assert.equal(fresh.counts.updatedDocuments, 3);
  const parentReview = (documentId: string) => fresh.documentRefresh?.find(row => row.documentId === documentId)?.fields.find(field => field.field === 'parentId');
  assert.deepEqual(parentReview(a.id), { field: 'parentId', current: root.title,
    incoming: `… / ${renamed.title} / ${b.title}`, decision: 'apply' });
  assert.deepEqual(parentReview(b.id), { field: 'parentId', current: `… / ${a.title}`, incoming: `… / ${renamed.title}`, decision: 'apply' });
  assert.equal(parentReview(beside.id)?.incoming, `… / ${renamed.title} / ${b.title} / ${a.title} / Page 600`);

  const unchanged = await f.docs();
  const revisionPath = `/documents/${a.id}/revisions`;
  const previousRevisions = await f.request<DocRevision[]>(revisionPath);
  f.db.exec(`CREATE TRIGGER fail_confluence_hierarchy_receipt BEFORE INSERT ON source_imports
    BEGIN SELECT RAISE(ABORT, 'synthetic hierarchy receipt failure'); END`);
  try { await f.apply(fresh, 500); }
  finally { f.db.exec('DROP TRIGGER fail_confluence_hierarchy_receipt'); }
  assert.deepEqual(await f.docs(), unchanged);
  assert.deepEqual(await f.request<DocRevision[]>(revisionPath), previousRevisions);
  assert.deepEqual(await order(a), oldOrder);
  assert.deepEqual(await order(first), newOrder);

  const [receipt, message] = await Promise.all([f.apply(fresh), nextCollaborationChange(peer)]);
  assert.equal(receipt.duplicate, false);
  assert.equal(message.type, 'update');
  assert.equal(message.epoch, session.epoch);
  assert.equal(message.document.parentId, b.id);
  assert.equal(message.document.version, session.document.version + 1);
  assert.deepEqual(message.document.content, session.document.content);
  const projected = await f.docs();
  const newPage = fromTitle(projected, 'Page 600');
  assert.equal(fromTitle(projected, 'Page 200').parentId, b.id);
  assert.equal(fromTitle(projected, 'Page 300').parentId, renamed.id);
  assert.equal(fromTitle(projected, 'Page 500').parentId, newPage.id);
  assert.equal(newPage.parentId, a.id);
  assert.deepEqual((await order(renamed)).documentIds, [formerSecond.id, renamed.id, formerFirst.id]);
  assert.deepEqual((await order(first)).documentIds, [second.id, first.id, b.id]);
  await f.request(orderPath(first), 409, 'PATCH', { expectedVersion: newOrder.version, documentIds: newOrder.documentIds });
  assert.equal((await f.apply(fresh, 200)).duplicate, true);
  assert.deepEqual(await f.docs(), projected);
  assert.equal((await f.request<DocRevision[]>(revisionPath)).length, previousRevisions.length + 1);
});
