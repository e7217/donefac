import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createApp } from '../../server/app.js';
import type { ApiKeyCreated, DocPage, DocumentPublicationView, WorkspaceSnapshot } from '../../shared/types.js';

type Tab = 'assigned' | 'requested' | 'published';
type Scope = 'workspace' | 'project' | 'common';
interface ListItem {
  documentId: string;
  projectId: string | null;
  documentVersion: number;
  revision: { id: string; version: number; title: string };
  status: 'pending' | 'changes_requested' | 'published';
  requestedById: string;
  reviewerId: string;
  actionAt: string;
}
interface PublicationList {
  tab: Tab;
  scope: Scope;
  projectId: string | null;
  offset: number;
  total: number;
  pendingAssigned: number;
  items: ListItem[];
}
const privateBody = 'RAW_DRAFT_BODY_DO_NOT_LIST';
const privateNote = 'PRIVATE_REVIEW_NOTE_DO_NOT_LIST';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'teamspace-publication-list-'));
  const service = createApp({ dataDir: dir, outboundWorker: false });
  const server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async <T = unknown>(path: string, method = 'GET', body?: unknown, actor = 'user-min', headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}/api${path}`, {
      method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actor, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() as T };
  };
  return {
    call,
    async close() {
      await new Promise<void>(resolve => server.close(() => resolve()));
      service.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function body(text = privateBody) { return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }; }
async function make(f: Fixture, title: string, projectId: string | null = 'project-neo') {
  const response = await f.call<DocPage>('/documents', 'POST', { projectId, title, content: body() });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  return response.data;
}
async function state(f: Fixture, id: string) {
  const response = await f.call<DocumentPublicationView>(`/documents/${id}/publication`);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data;
}
async function action(f: Fixture, before: DocumentPublicationView, name: string, actor: string, extra: Record<string, unknown> = {}) {
  const response = await f.call<DocumentPublicationView>(`/documents/${before.documentId}/publication`, 'POST', {
    action: name, expectedVersion: before.version, workspaceGeneration: before.workspaceGeneration, note: privateNote, ...extra,
  }, actor);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data;
}
async function request(f: Fixture, document: DocPage, actor = 'user-min', reviewerId = 'user-seo') {
  return action(f, await state(f, document.id), 'request', actor, { expectedDocumentVersion: document.version, reviewerId });
}
async function edit(f: Fixture, document: DocPage, title: string) {
  const response = await f.call<DocPage>(`/documents/${document.id}`, 'PATCH', { expectedVersion: document.version, title, content: body(`${privateBody} later draft`) });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data;
}
function assertLightweight(list: PublicationList) {
  assert.deepEqual(Object.keys(list).sort(), ['tab', 'scope', 'projectId', 'offset', 'total', 'pendingAssigned', 'items'].sort());
  for (const item of list.items) {
    assert.deepEqual(Object.keys(item).sort(), ['documentId', 'projectId', 'documentVersion', 'revision', 'status', 'requestedById', 'reviewerId', 'actionAt'].sort());
    assert.deepEqual(Object.keys(item.revision).sort(), ['id', 'title', 'version']);
    assert.ok(Number.isSafeInteger(item.documentVersion));
    assert.ok(Number.isSafeInteger(item.revision.version));
  }
  const serialized = JSON.stringify(list);
  assert.equal(serialized.includes(privateBody), false);
  assert.equal(serialized.includes(privateNote), false);
}
async function list(f: Fixture, actor: string, query: Record<string, string> = {}) {
  const response = await f.call<PublicationList>(`/document-publications?${new URLSearchParams(query)}`, 'GET', undefined, actor);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assertLightweight(response.data);
  return response.data;
}
const ids = (result: PublicationList) => result.items.map(item => item.documentId).sort();

test('assigned/requested lists isolate actors and follow feedback, publication, new review and withdrawal across tabs', async () => {
  const f = await fixture();
  try {
    const own = await make(f, '내가 요청한 검토');
    const assigned = await make(f, '나에게 배정된 검토');
    const changes = await make(f, '수정 요청 받은 검토');
    let published = await make(f, '처음 발행한 고정 제목');
    const other = await make(f, '다른 작업자가 요청한 검토');
    const ownState = await request(f, own);
    await request(f, assigned, 'user-jun', 'user-min');
    const changesState = await request(f, changes, 'user-min', 'user-jun');
    const feedback = await action(f, changesState, 'request_changes', 'user-jun');
    const firstReview = await request(f, published);
    const firstPublished = await action(f, firstReview, 'publish', 'user-seo');
    const pinned = firstPublished.publishedRevision!;
    published = await edit(f, published, '다음 검토본 제목');
    const secondReview = await request(f, published, 'user-min', 'user-jun');
    published = await edit(f, published, 'DRAFT_TITLE_MUST_NOT_REPLACE_PINNED');
    await request(f, other, 'user-jun', 'user-seo');

    const mine = await list(f, 'user-min');
    assert.deepEqual({ tab: mine.tab, scope: mine.scope, projectId: mine.projectId, offset: mine.offset }, { tab: 'assigned', scope: 'workspace', projectId: null, offset: 0 });
    assert.deepEqual(ids(mine), [assigned.id]);
    assert.equal(mine.pendingAssigned, 1);
    const requested = await list(f, 'user-min', { tab: 'requested' });
    assert.deepEqual(ids(requested), [own.id, changes.id, published.id].sort());
    assert.equal(requested.items.find(item => item.documentId === changes.id)!.status, 'changes_requested');
    assert.equal(requested.items.find(item => item.documentId === changes.id)!.actionAt, feedback.review!.changesRequested!.at);
    assert.equal(requested.items.find(item => item.documentId === published.id)!.revision.title, '다음 검토본 제목');
    assert.equal(requested.items.find(item => item.documentId === published.id)!.documentVersion, published.version);
    assert.equal(requested.items.find(item => item.documentId === published.id)!.actionAt, secondReview.review!.requestedAt);
    const assignedJun = await list(f, 'user-jun');
    assert.equal(assignedJun.total, 1);
    assert.equal(assignedJun.pendingAssigned, 1);
    const assignedSeo = await list(f, 'user-seo');
    assert.equal(assignedSeo.total, 2);
    assert.equal(assignedSeo.pendingAssigned, 2);
    assert.deepEqual(ids(await list(f, 'user-jun', { tab: 'requested' })), [assigned.id, other.id].sort());
    assert.equal((await list(f, 'user-yun')).total, 0);
    assert.equal((await list(f, 'user-yun', { tab: 'requested' })).total, 0);
    const publicList = await list(f, 'user-yun', { tab: 'published' });
    assert.equal(publicList.items.length, 1);
    assert.deepEqual(publicList.items[0].revision, pinned);
    assert.equal(publicList.items[0].status, 'published');
    assert.equal(publicList.items[0].actionAt, firstPublished.published!.publishedAt);
    assert.equal(publicList.items[0].documentVersion, published.version);
    assert.equal((await list(f, 'user-yun', { tab: 'published', q: 'DRAFT_TITLE_MUST_NOT_REPLACE_PINNED' })).total, 0);
    assert.equal((await list(f, 'user-min', { tab: 'requested', q: privateBody })).total, 0);
    assert.equal((await list(f, 'user-min', { tab: 'requested', q: privateNote })).total, 0);

    await action(f, secondReview, 'publish', 'user-jun');
    const completedJun = await list(f, 'user-jun');
    assert.equal(completedJun.total, 0);
    assert.equal(completedJun.pendingAssigned, 0);
    assert.deepEqual(ids(await list(f, 'user-min', { tab: 'requested' })), [own.id, changes.id].sort());
    assert.equal((await list(f, 'user-yun', { tab: 'published' })).items[0].revision.title, '다음 검토본 제목');
    await action(f, ownState, 'withdraw', 'user-min');
    assert.deepEqual(ids(await list(f, 'user-seo')), [other.id]);
    assert.deepEqual(ids(await list(f, 'user-min', { tab: 'requested' })), [changes.id]);
  } finally { await f.close(); }
});

test('workspace/project/common scopes and NFC case-insensitive pinned-title search remain exact without searching private fields', async () => {
  const f = await fixture();
  try {
    const decomposed = 'Café 한글 ΩMEGA'.normalize('NFD');
    const neo = await make(f, decomposed);
    const team = await make(f, '팀 문서 API', 'project-team');
    const common = await make(f, '공통 검토 문서', null);
    const compatibility = await make(f, 'ＡＰＩ 전용 문서');
    for (const doc of [neo, team, common, compatibility]) await request(f, doc);
    const workspace = await list(f, 'user-seo');
    assert.equal(workspace.total, 4);
    const project = await list(f, 'user-seo', { scope: 'project', projectId: 'project-neo' });
    assert.equal(project.projectId, 'project-neo');
    assert.deepEqual(ids(project), [neo.id, compatibility.id].sort());
    assert.deepEqual(ids(await list(f, 'user-seo', { scope: 'project', projectId: 'project-team' })), [team.id]);
    const shared = await list(f, 'user-seo', { scope: 'common' });
    assert.equal(shared.projectId, null);
    assert.deepEqual(ids(shared), [common.id]);
    assert.equal(shared.items[0].projectId, null);
    for (const query of ['  CAFÉ 한글 ωmega  ', 'café 한글 ΩMEGA'.normalize('NFD')]) {
      const result = await list(f, 'user-seo', { q: query });
      assert.deepEqual(ids(result), [neo.id]);
      assert.equal(result.items[0].revision.title, decomposed);
    }
    assert.deepEqual(ids(await list(f, 'user-seo', { q: 'api' })), [team.id]);
    assert.deepEqual(ids(await list(f, 'user-seo', { q: 'ａｐｉ' })), [compatibility.id]);
    for (const query of [privateBody, privateNote, '찾을 수 없는 제목', "%' OR 1=1 --"]) {
      const result = await list(f, 'user-seo', { scope: 'common', q: query });
      assert.equal(result.total, 0);
      assert.deepEqual(result.items, []);
      assert.equal(result.pendingAssigned, 4);
    }
    assert.equal((await list(f, 'user-min', { tab: 'requested', scope: 'common' })).pendingAssigned, 0);
  } finally { await f.close(); }
});

test('fixed 30-row pages sort by action time then document ID while pendingAssigned ignores tab, scope, search and offset', async () => {
  const f = await fixture();
  try {
    const created = await Promise.all(Array.from({ length: 33 }, async (_, index) => {
      const projectId = index < 20 ? 'project-neo' : index < 32 ? 'project-team' : null;
      const doc = await make(f, `페이지 검증 ${String(index).padStart(2, '0')}`, projectId);
      return { doc, state: await request(f, doc) };
    }));
    const ordered = [...created].sort((left, right) =>
      right.state.review!.requestedAt.localeCompare(left.state.review!.requestedAt) ||
      (left.doc.id < right.doc.id ? -1 : left.doc.id > right.doc.id ? 1 : 0),
    );
    const first = await list(f, 'user-seo');
    assert.equal(first.total, 33);
    assert.equal(first.items.length, 30);
    assert.equal(first.pendingAssigned, 33);
    assert.deepEqual(first.items.map(item => item.documentId), ordered.slice(0, 30).map(value => value.doc.id));
    const second = await list(f, 'user-seo', { offset: '30' });
    assert.equal(second.offset, 30);
    assert.equal(second.total, 33);
    assert.equal(second.items.length, 3);
    assert.equal(second.pendingAssigned, 33);
    assert.deepEqual(second.items.map(item => item.documentId), ordered.slice(30).map(value => value.doc.id));
    assert.deepEqual(first.items.concat(second.items).map(item => item.actionAt), ordered.map(value => value.state.review!.requestedAt));
    assert.equal(new Set([...first.items, ...second.items].map(item => item.documentId)).size, 33);
    assert.deepEqual((await list(f, 'user-seo', { offset: '31' })).items.map(item => item.documentId), ordered.slice(31).map(value => value.doc.id));
    const emptyPage = await list(f, 'user-seo', { offset: '1000000' });
    assert.equal(emptyPage.total, 33);
    assert.deepEqual(emptyPage.items, []);
    assert.equal(emptyPage.pendingAssigned, 33);
    const scoped = await list(f, 'user-seo', { scope: 'project', projectId: 'project-neo', q: '페이지 검증 00' });
    assert.equal(scoped.total, 1);
    assert.equal(scoped.items[0].documentId, created[0].doc.id);
    assert.equal(scoped.pendingAssigned, 33);
    for (const tab of ['requested', 'published'] as const) {
      const result = await list(f, 'user-seo', { tab });
      assert.equal(result.total, 0);
      assert.equal(result.pendingAssigned, 33);
    }
    const requester = await list(f, 'user-min', { tab: 'requested' });
    assert.equal(requester.total, 33);
    assert.equal(requester.pendingAssigned, 0);
    const badge = await f.call('/document-publications/count', 'GET', undefined, 'user-seo');
    assert.equal(badge.status, 200);
    assert.deepEqual(badge.data, { pendingAssigned: 33 });
    const requesterBadge = await f.call('/document-publications/count', 'GET', undefined, 'user-min');
    assert.equal(requesterBadge.status, 200);
    assert.deepEqual(requesterBadge.data, { pendingAssigned: 0 });
  } finally { await f.close(); }
});

test('query validation requires exact project scope/scalar selectors and the list route is excluded from bearer v1 automation', async () => {
  const f = await fixture();
  try {
    const invalid = [
      'tab=unknown', 'tab=assigned&tab=requested', 'scope=unknown', 'scope=project',
      'scope=project&projectId=', 'scope=workspace&projectId=project-neo', 'scope=common&projectId=project-neo',
      'scope=project&projectId=project-neo&projectId=project-team', 'scope=project&projectId[]=project-neo',
      'q[]=query', 'q=one&q=two', `q=${'a'.repeat(201)}`, 'q=%00',
      'offset=-1', 'offset=1.5', 'offset=NaN', 'offset=1000001', 'offset[]=0', 'offset=0&offset=30',
    ];
    for (const query of invalid) {
      const response = await f.call(`/document-publications?${query}`);
      assert.equal(response.status, 400, `${query}: ${JSON.stringify(response.data)}`);
    }
    assert.equal((await f.call('/document-publications?scope=project&projectId=missing-project')).status, 404);
    assert.equal((await f.call('/document-publications', 'GET', undefined, 'missing-actor')).status, 400);
    assert.equal((await f.call('/document-publications/count?tab=assigned')).status, 400);
    for (const access of ['read', 'write'] as const) {
      const key = await f.call<ApiKeyCreated>('/api-keys', 'POST', { name: '목록 범위 합성 키', access, projectIds: null, expiresAt: null });
      assert.equal(key.status, 201);
      const headers = { Authorization: `Bearer ${key.data.token}` };
      assert.equal((await f.call('/v1/document-publications?tab=assigned&scope=workspace', 'GET', undefined, 'user-seo', headers)).status, 403);
      assert.equal((await f.call('/v1/document-publications?tab=published&scope=project&projectId=project-neo', 'GET', undefined, 'user-seo', headers)).status, 403);
      assert.equal((await f.call('/v1/document-publications/count', 'GET', undefined, 'user-seo', headers)).status, 403);
    }
  } finally { await f.close(); }
});

test('native restore keeps pinned list metadata and refreshed document versions, while deletion removes rows and actor counts', async () => {
  const f = await fixture();
  try {
    const pending = await make(f, '복원할 대기 문서');
    await request(f, pending);
    let published = await make(f, '복원할 발행 고정 제목');
    const review = await request(f, published, 'user-min', 'user-jun');
    await action(f, review, 'publish', 'user-jun');
    published = await edit(f, published, 'RESTORED_DRAFT_TITLE_MUST_NOT_LEAK');
    const beforeAssigned = await list(f, 'user-seo');
    const beforePublished = await list(f, 'user-seo', { tab: 'published' });
    const backup = await f.call<WorkspaceSnapshot & { schemaVersion: number }>('/export');
    assert.equal(backup.status, 200);
    assert.equal(backup.data.schemaVersion, 18);
    assert.equal((await f.call('/import', 'POST', { data: backup.data })).status, 200);
    const afterAssigned = await list(f, 'user-seo');
    const afterPublished = await list(f, 'user-seo', { tab: 'published' });
    assert.equal(afterAssigned.pendingAssigned, 1);
    assert.deepEqual(afterAssigned.items[0].revision, beforeAssigned.items[0].revision);
    assert.equal(afterAssigned.items[0].actionAt, beforeAssigned.items[0].actionAt);
    assert.ok(afterAssigned.items[0].documentVersion > beforeAssigned.items[0].documentVersion);
    assert.deepEqual(afterPublished.items[0].revision, beforePublished.items[0].revision);
    assert.equal(afterPublished.items[0].revision.title, '복원할 발행 고정 제목');
    assert.ok(afterPublished.items[0].documentVersion > published.version);
    const workspace = (await f.call<WorkspaceSnapshot>('/workspace')).data;
    const currentPending = workspace.documents.find(value => value.id === pending.id)!;
    assert.equal((await f.call(`/documents/${pending.id}?expectedVersion=${currentPending.version}`, 'DELETE')).status, 200);
    const removed = await list(f, 'user-seo');
    assert.equal(removed.total, 0);
    assert.equal(removed.pendingAssigned, 0);
    assert.equal((await list(f, 'user-seo', { tab: 'published' })).total, 1);
    const currentPublished = workspace.documents.find(value => value.id === published.id)!;
    assert.equal((await f.call(`/documents/${published.id}?expectedVersion=${currentPublished.version}`, 'DELETE')).status, 200);
    assert.equal((await list(f, 'user-seo', { tab: 'published' })).total, 0);
    assert.equal((await list(f, 'user-min', { tab: 'requested' })).total, 0);
  } finally { await f.close(); }
});
