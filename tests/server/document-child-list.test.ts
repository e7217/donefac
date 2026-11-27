import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../server/app.js';
import type { CollaborationExport } from '../../server/collaboration.js';
import { COLLABORATION_SCHEMA, type CollaborationSession } from '../../shared/collaboration.js';
import { DOCUMENT_CHILD_LIST_DEFAULTS, documentChildListDescription, normalizeDocumentChildListOptions, projectDocumentChildren,
  MAX_DOCUMENT_CHILD_LIST_ITEMS, MAX_DOCUMENT_CHILD_LISTS } from '../../shared/document-child-list.js';
import { contentReferences, documentContentSchemaVersion } from '../../shared/document-nodes.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type { ApiKeyCreated, DocPage, RichContent, WorkspaceSnapshot } from '../../shared/types.js';

const body = (...content: RichContent[]): RichContent => ({ type: 'doc', content });
const childList = (attrs: Record<string, unknown> = {}): RichContent => ({ type: 'documentChildList', attrs });
const paragraph = (text: string): RichContent => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const instant = '2026-11-21T00:00:00.000Z';

function page(id: string, title: string, parentId: string | null, fields: Partial<DocPage> = {}): DocPage {
  return { id, projectId: 'project-neo', parentId, title, icon: '📄', status: 'draft', authorId: 'user-min',
    version: 1, content: body(paragraph(title)), plainText: title, createdAt: instant, updatedAt: instant, ...fields };
}

test('child list projects only the selected live tree, sorts each branch and limits the first level separately', () => {
  const root = page('root', '운영 문서', null);
  const spaceRoot = page('other', '시작하기', null, { createdAt: '2026-11-20T00:00:00.000Z' });
  const a = page('a', '절 10', root.id);
  const b = page('b', '절 2', root.id);
  const grandchild = page('leaf', '상세 항목', b.id);
  const [crossSpace, hiddenSibling] = [
    page('foreign', '다른 프로젝트', b.id, { projectId: 'project-team' }),
    page('hidden-sibling', '현재 목록 밖', spaceRoot.id),
  ];
  const records = [a, root, crossSpace, hiddenSibling, spaceRoot, grandchild, b];
  const project = (attrs: Record<string, unknown>, current: string | null = root.id) =>
    projectDocumentChildren(records, current, normalizeDocumentChildListOptions(attrs)!);
  const ids = (value: ReturnType<typeof project>) => value.items.map(row => [row.document.id, row.depth]);
  assert.deepEqual(ids(project({})), [[b.id, 1], [a.id, 1]]);
  assert.deepEqual(ids(project({ depth: 'all', first: 1 })), [[b.id, 1], [grandchild.id, 2]]);
  assert.deepEqual(ids(project({ scope: 'document', documentId: spaceRoot.id, depth: 'all' }, a.id)), [[hiddenSibling.id, 1]]);
  assert.deepEqual(ids(project({ scope: 'current-space', sort: 'created', descending: true, first: 1 })), [[root.id, 1]]);
  assert.deepEqual(ids(project({ scope: 'space', projectId: 'project-team', depth: 'all' })), []);
  assert.equal(project({ scope: 'document', documentId: 'disappeared' }).available, false);
  assert.equal(project({}, null).available, false);

  const overflow = projectDocumentChildren([root, ...Array.from({ length: MAX_DOCUMENT_CHILD_LIST_ITEMS + 1 }, (_, index) =>
    page(`overflow-${index}`, `가이드 ${index}`, root.id))], root.id, DOCUMENT_CHILD_LIST_DEFAULTS);
  assert.equal(overflow.items.length, MAX_DOCUMENT_CHILD_LIST_ITEMS);
  assert.equal(overflow.truncated, true);
});

test('child list ranks live siblings from custom orders in the selected space and reverses each level before limiting', () => {
  const documents = [
    page('root', '팀 문서 10', null), page('other-root', '팀 문서 2', null),
    page('a', '절 10', 'root'), page('b', '절 2', 'root'), page('c', '절 1', 'root'),
    page('a2', '상세 2', 'a'), page('a10', '상세 10', 'a'),
    page('b2', '상세 2', 'b'), page('b10', '상세 10', 'b'),
    page('wrong-parent', '다른 상위 문서', 'other-root'),
    page('wrong-project', '다른 프로젝트', 'root', { projectId: 'project-team' }),
    page('team-root', '팀 문서 10', null, { projectId: 'project-team' }),
    page('team-other-root', '팀 문서 2', null, { projectId: 'project-team' }),
  ];
  const version = '0'.repeat(64);
  const orders: NonNullable<WorkspaceSnapshot['documentOrders']> = [
    { projectId: 'project-neo', parentId: null, documentIds: ['root', 'other-root'], version, custom: true },
    { projectId: 'project-neo', parentId: 'root', documentIds: ['c', 'a', 'stale', 'wrong-project', 'wrong-parent', 'c'], version, custom: true },
    { projectId: 'project-neo', parentId: 'a', documentIds: ['a10', 'a2'], version, custom: true },
    { projectId: 'project-neo', parentId: 'b', documentIds: ['b10', 'b2'], version },
    { projectId: 'project-team', parentId: 'root', documentIds: ['b', 'wrong-project'], version, custom: true },
    { projectId: 'project-team', parentId: null, documentIds: ['team-root', 'team-other-root'], version, custom: true },
  ];
  const project = (attrs: Record<string, unknown>, siblingOrders = orders, current = 'root') =>
    projectDocumentChildren(documents, current, normalizeDocumentChildListOptions(attrs)!, siblingOrders)
      .items.map(({ document }) => document.id);
  assert.equal(normalizeDocumentChildListOptions(undefined)?.sort, 'title');
  assert.match(documentChildListDescription(normalizeDocumentChildListOptions({ sort: 'manual' })!), /사용자 지정 순서 오름차순/u);
  assert.deepEqual(project({}), ['c', 'b', 'a']);
  assert.deepEqual(project({ sort: 'manual' }), ['a', 'c', 'b']);
  assert.deepEqual(project({ sort: 'manual', depth: 'all', first: 1 }), ['a', 'a10', 'a2']);
  assert.deepEqual(project({ sort: 'manual', depth: 'all', first: 1, descending: true }), ['b', 'b10', 'b2']);
  assert.deepEqual(project({ sort: 'manual', scope: 'document', documentId: 'a', descending: true }, orders, 'team-root'), ['a2', 'a10']);
  assert.deepEqual(project({ sort: 'manual', scope: 'current-space' }), ['root', 'other-root']);
  assert.deepEqual(project({ sort: 'manual', scope: 'space', projectId: 'project-team' }), ['team-root', 'team-other-root']);
  assert.deepEqual(project({ sort: 'manual' }, []), ['c', 'b', 'a']);
  assert.deepEqual(project({ sort: 'manual' }, [...orders, orders[1]]), ['c', 'b', 'a']);
});

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'donefac-document-child-list-'));
  const service = createApp({ dataDir: directory, outboundWorker: false });
  const server = service.app.listen(0, '127.0.0.1');
  t.after(async () => {
    try {
      await new Promise<void>(resolve => server.close(() => resolve()));
      service.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  async function call<T = unknown>(path: string, method = 'GET', payload?: unknown, token?: string) {
    const response = await fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : { 'X-Actor-Id': 'user-min' }) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    return { status: response.status, data: await response.json() as T };
  }
  async function create(title: string, content = body(paragraph(title)), projectId: string | null = 'project-neo') {
    const response = await call<DocPage>('/documents', 'POST', { title, content, projectId });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data;
  }
  return { call, create };
}

test('child list validates settings and older save formats, and restores current and prior collaborative formats', async t => {
  const f = await fixture(t);
  const target = await f.create('운영 절차');
  const attrs = { depth: 'all', first: 3, scope: 'document', documentId: target.id, title: ' 운영 안내 ', style: 'h3', sort: 'manual' };
  const authored = await f.create('운영 문서 목록', body(childList(attrs)));
  const path = `/documents/${authored.id}`;
  const canonical = body(childList({ ...DOCUMENT_CHILD_LIST_DEFAULTS, ...attrs, title: '운영 안내' }));
  assert.deepEqual(authored.content, canonical);
  assert.equal(documentContentSchemaVersion(authored.content), 14);
  assert.equal(documentContentSchemaVersion(body(childList())), 10);
  assert.deepEqual(contentReferences(authored.content), [{ type: 'document', id: target.id, kind: 'reference', label: '운영 안내' }]);
  assert.match(authored.plainText, /하위 문서 목록.*운영 안내.*모든 하위 단계.*사용자 지정 순서/u);
  for (const bad of [{ depth: 0 }, { depth: 61 }, { first: 0 }, { first: 501 }, { descending: 'yes' }, { sort: 'random' },
    { style: 'a' }, { title: '줄\n바꿈' }, { snapshot: true }, { documentId: target.id }, { scope: 'document' },
    { scope: 'document', documentId: 'missing-document' }, { scope: 'space', projectId: 'missing-project' }]) {
    const invalid = await f.call('/documents', 'POST', { title: '검증할 잘못된 목록', projectId: 'project-neo', content: body(childList(bad)) });
    assert.equal(invalid.status, 422, JSON.stringify([bad, invalid.data]));
  }
  assert.equal((await f.call('/documents', 'POST', { title: '목록 개수 한도', projectId: 'project-neo',
    content: body(...Array.from({ length: MAX_DOCUMENT_CHILD_LISTS + 1 }, () => childList())) })).status, 422);
  const oldWrite = await f.call<{ details: { contentSchemaVersion: number } }>(path, 'PATCH', {
    expectedVersion: authored.version, contentSchemaVersion: 13, content: body(paragraph('오래된 편집기의 본문')),
  });
  assert.equal(oldWrite.status, 409);
  assert.equal(oldWrite.data.details.contentSchemaVersion, 14);

  const v9 = await f.create('이전 공동 편집 문서', body({ type: 'documentLabelList', attrs: { projectId: 'project-neo' } }));
  for (const doc of [authored, v9]) {
    const saved = await f.call<CollaborationSession>(`/documents/${doc.id}/collaboration/enable`, 'POST', { expectedVersion: doc.version });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.equal(saved.data.schemaVersion, COLLABORATION_SCHEMA);
  }
  const exported = (await f.call<WorkspaceSnapshot & { schemaVersion: number; collabStates: CollaborationExport[] }>('/export')).data;
  assert.equal(exported.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.equal((await f.call('/import', 'POST', { data: { ...exported, schemaVersion: 66 } })).status, 400);
  const mistakenSchema = { ...exported, collabStates: exported.collabStates.map(state =>
    state.documentId === authored.id ? { ...state, schemaVersion: 9 } : state) };
  assert.equal((await f.call('/import', 'POST', { data: mistakenSchema })).status, 422);

  const legacy = exported.collabStates.find(state => state.documentId === v9.id)!;
  legacy.schemaVersion = 9;
  const restored = await f.call('/import', 'POST', { data: exported });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  for (const original of [authored, v9]) {
    const session = (await f.call<CollaborationSession>(`/documents/${original.id}/collaboration`)).data;
    assert.equal(session.schemaVersion, COLLABORATION_SCHEMA);
    assert.notEqual(session.epoch, exported.collabStates.find(value => value.documentId === original.id)!.epoch);
    assert.deepEqual(session.document.content, original.content);
  }
});

test('scoped API keys check the chosen child-list parent project and follow changes to that parent', async t => {
  const f = await fixture(t);
  const root = await f.create('공간 이동 대상');
  const host = await f.create('조회하는 문서', body(childList({ scope: 'document', documentId: root.id })));
  const foreign = await f.create('다른 공간으로 고정', body(childList({ scope: 'space', projectId: 'project-team' })));
  const relative = await f.create('현재 공간의 최상위 목록', body(childList({ scope: 'current-space' })));
  const key = await f.call<ApiKeyCreated>('/api-keys', 'POST', { name: '문서 범위 자동화', access: 'write', projectIds: ['project-neo'] });
  assert.equal(key.status, 201, JSON.stringify(key.data));
  const { token } = key.data;
  const read = (document: DocPage) => f.call(`/v1/documents/${document.id}`, 'GET', undefined, token);
  assert.equal((await read(host)).status, 200);
  assert.equal((await read(foreign)).status, 403);
  assert.equal((await read(relative)).status, 200);
  for (const projectId of ['project-team', null]) {
    const rejected = await f.call('/v1/documents', 'POST', { title: '범위 밖 기준 공간', projectId: 'project-neo',
      content: body(childList({ scope: 'space', projectId })) }, token);
    assert.equal(rejected.status, 403);
  }
  const moved = await f.call(`/documents/${root.id}`, 'PATCH', { expectedVersion: root.version, projectId: 'project-team' });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  assert.equal((await read(host)).status, 403);
  const listing = await f.call<DocPage[]>('/v1/documents', 'GET', undefined, token);
  assert.ok(listing.data.some(document => document.id === relative.id));
  assert.ok(!listing.data.some(document => document.id === host.id || document.id === foreign.id));
});
