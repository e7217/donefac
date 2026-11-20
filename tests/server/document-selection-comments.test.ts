import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type {
  ApiKeyCreated, Comment, DocPage, DocRevision, DocumentSelectionCommentResult, RichContent, TeamNotificationPage, WorkspaceSnapshot,
} from '../../shared/types.js';

const owner = 'user-seo';
const reviewer = 'user-min';
const projectId = 'project-neo';
const quote = '실측 조건과 확인 기준';
const paragraph = (text: string): RichContent => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const content = (...nodes: RichContent[]): RichContent => ({ type: 'doc', content: nodes });
const pathFor = (id: string) => `/documents/${id}/selection-comments`;
const commentsPath = (id: string) => `/comments?resourceType=document&resourceId=${id}`;
const revisionsPath = (id: string) => `/documents/${id}/revisions`;
const requestFor = (document: DocPage, body = '첫 문장의 검증 범위를 구체화해 주세요.') => ({
  requestId: randomUUID(), expectedDocumentVersion: document.version,
  sourceSelection: { from: 1, to: quote.length + 1, text: quote }, body,
});

type Backup = WorkspaceSnapshot & {
  schemaVersion: number;
  comments: Comment[];
  revisions: DocRevision[];
  trashEntries: { id: string; comments: Comment[]; revisions: DocRevision[] }[];
  trashItems: { id: string; item: Comment }[];
};
type RequestOptions = { method?: string; body?: unknown; actor?: string; headers?: Record<string, string> };

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teamspace-selection-comments-'));
  async function start() {
    const app = createApp({ dataDir: directory, outboundWorker: false });
    const server = app.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { app, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api` };
  }
  let service = await start();
  async function close() {
    const { app, server } = service;
    server.closeAllConnections();
    try { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    finally { app.close(); }
  }
  t.after(async () => {
    try { await close(); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  });
  async function request<T = unknown>(path: string, { method = 'GET', body, actor = reviewer, headers }: RequestOptions = {}) {
    const response = await fetch(service.base + path, {
      method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actor, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() as T };
  }
  async function call<T = unknown>(path: string, options?: RequestOptions, status = 200) {
    const response = await request<T>(path, options);
    assert.equal(response.status, status, `${options?.method ?? 'GET'} ${path}: ${JSON.stringify(response.data)}`);
    return response.data;
  }
  async function create(title: string, body = content(paragraph(quote)), project: string | null = projectId) {
    return call<DocPage>('/documents', { method: 'POST', actor: owner, body: { title, projectId: project, content: body } }, 201);
  }
  async function restart() { await close(); service = await start(); }
  return { directory, create, request, call, restart };
}

test('selection comments keep a canonical original, roll back failed receipts and retry without extra comments or alerts', async t => {
  const f = await fixture(t);
  const document = await f.create('공통 문서의 원문 검토', undefined, null);
  const path = pathFor(document.id);
  const input = requestFor(document, '  여기에 시험 조건을 추가해 주세요.  ');
  const send = { method: 'POST', body: input };
  const ordinary = await f.call<Comment>('/comments', { method: 'POST', body: {
    body: '문서 전체 댓글', resourceType: 'document', resourceId: document.id, documentSource: input.sourceSelection,
  } }, 201);
  assert.equal(ordinary.documentSource, undefined);
  const before = await f.call<WorkspaceSnapshot>('/workspace');
  const beforeNotices = await f.call<TeamNotificationPage>('/notifications', { actor: owner });
  assert.equal((await f.request(path, { ...send, body: { ...input, body: ' ' } })).status, 400);
  assert.equal((await f.request(path, { ...send, body: { ...input, sourceSelection: { ...input.sourceSelection, to: 1 } } })).status, 400);
  const mismatch = await f.call<{ details: { reason: string } }>(path, { ...send, body: {
    ...input, sourceSelection: { ...input.sourceSelection, text: '선택과 다른 문장' },
  } }, 409);
  assert.equal(mismatch.details.reason, 'source_selection_changed');

  const sql = new DatabaseSync(join(f.directory, 'teamspace.sqlite'));
  try {
    // An acknowledged live edit can exist without its own checkpoint revision.
    sql.prepare('DELETE FROM revisions WHERE document_id=?').run(document.id);
    sql.exec(`CREATE TRIGGER fail_synthetic_selection_comment BEFORE INSERT ON document_selection_comment_requests
      BEGIN SELECT RAISE(ABORT, 'synthetic selection comment receipt failure'); END`);
    await f.call(path, send, 500);
    assert.deepEqual(await f.call<DocRevision[]>(revisionsPath(document.id)), []);
    assert.deepEqual(await f.call<Comment[]>(commentsPath(document.id)), [ordinary]);
    assert.deepEqual(await f.call<WorkspaceSnapshot>('/workspace'), before);
    assert.deepEqual(await f.call<TeamNotificationPage>('/notifications', { actor: owner }), beforeNotices);
  } finally {
    sql.exec('DROP TRIGGER IF EXISTS fail_synthetic_selection_comment');
    sql.close();
  }

  const concurrent = await Promise.all([f.request<DocumentSelectionCommentResult>(path, send), f.request<DocumentSelectionCommentResult>(path, send)]);
  assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 201]);
  const { comment, duplicate } = concurrent.find(result => result.status === 201)!.data;
  assert.equal(duplicate, false);
  const [pin] = await f.call<DocRevision[]>(revisionsPath(document.id));
  assert.ok(pin);
  assert.equal(pin.version, document.version);
  assert.deepEqual(pin.content, document.content);
  assert.deepEqual(comment.documentSource, { revisionId: pin.id, ...input.sourceSelection });
  assert.equal(comment.body, input.body.trim());
  assert.equal(comment.authorId, reviewer);
  assert.deepEqual(concurrent.find(result => result.status === 200)!.data, { comment, duplicate: true });
  const after = await f.call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(after.documents.find(value => value.id === document.id), document);
  assert.equal(after.activities.length, before.activities.length + 1);
  const afterNotices = await f.call<TeamNotificationPage>('/notifications', { actor: owner });
  const notices = afterNotices.items.filter(item => !beforeNotices.items.some(value => value.id === item.id));
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'document-comment');
  assert.equal(notices[0].targetId, document.id);
  assert.ok(!JSON.stringify(notices).includes(comment.body));
  assert.ok(!JSON.stringify(notices).includes(quote));

  await f.call(`/documents/${document.id}`, { method: 'PATCH', body: {
    expectedVersion: document.version, title: '교정한 본문', content: content(paragraph('최신 검토 문장')),
  } });
  await f.restart();
  assert.deepEqual(await f.call(path, send), { comment, duplicate: true });
  await f.call(path, { ...send, actor: owner }, 409);
  await f.call(path, { ...send, body: { ...input, body: '같은 요청의 다른 내용' } }, 409);
  const stale = await f.call<{ details: { reason: string } }>(path, { ...send, body: { ...input, requestId: randomUUID() } }, 409);
  assert.equal(stale.details.reason, 'source_version_changed');
  const revisionPath = `/documents/${document.id}/include-revisions/${pin.id}`;
  assert.deepEqual(await f.call<DocRevision>(revisionPath), pin);

  const archived = await f.call<{ trashItemId: string }>(`/comments/${comment.id}`, { method: 'DELETE' });
  await f.call(path, send, 409);
  await f.call(`/trash/items/${archived.trashItemId}/restore`, { method: 'POST', body: {} });
  assert.deepEqual(await f.call(path, send), { comment, duplicate: true });
  assert.deepEqual((await f.call<Comment[]>(commentsPath(document.id))).map(value => value.id), [ordinary.id, comment.id]);
});

test('native selection-comment backups verify live and trashed originals and retain portable replay protection', async t => {
  const f = await fixture(t);
  const other = await fixture(t);
  const source = await f.create('발췌 원본');
  const foreign = await f.create('같은 문장이 있는 다른 원본');
  const foreignRevision = (await f.call<DocRevision[]>(revisionsPath(foreign.id)))[0];
  const path = pathFor(source.id);
  const legacy = await f.call<Backup>('/export');
  const firstInput = requestFor(source);
  const first = (await f.call<DocumentSelectionCommentResult>(path, { method: 'POST', body: firstInput }, 201)).comment;
  const second = (await f.call<DocumentSelectionCommentResult>(path, { method: 'POST', body: requestFor(source, '별도로 남긴 검토 의견') }, 201)).comment;
  assert.equal(first.documentSource?.revisionId, second.documentSource?.revisionId);
  const active = await f.call<Backup>('/export');
  assert.equal(active.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  const restore = (backup: Backup, status = 200) => other.call<{ error?: string }>('/import', { method: 'POST', body: { data: backup } }, status);
  assert.match((await restore({ ...active, schemaVersion: 49 }, 400)).error!, /schemaVersion 50/);
  const changed = structuredClone(active);
  changed.comments.find(value => value.id === first.id)!.documentSource!.text = '임의로 바꾼 본문';
  await restore(changed, 400);
  const movedPin = structuredClone(active);
  movedPin.comments.find(value => value.id === first.id)!.documentSource!.revisionId = foreignRevision.id;
  await restore(movedPin, 400);
  const historic = structuredClone(active);
  historic.revisions.find(value => value.id === first.documentSource!.revisionId)!.confluenceSourceVersion = 1;
  await restore(historic, 400);
  const wrongResource = structuredClone(active);
  Object.assign(wrongResource.comments.find(value => value.id === first.id)!, { resourceType: 'issue', resourceId: active.issues[0].id });
  await restore(wrongResource, 400);

  await restore(active);
  const replay = await other.call<{ details: { reason: string } }>(path, { method: 'POST', body: firstInput }, 409);
  assert.equal(replay.details.reason, 'receipt_unavailable');
  assert.deepEqual(await other.call<Comment[]>(commentsPath(source.id)), [first, second]);
  const item = await f.call<{ trashItemId: string }>(`/comments/${second.id}`, { method: 'DELETE' });
  const document = await f.call<{ trashEntryId: string }>(`/documents/${source.id}`, { method: 'DELETE', body: { expectedVersion: source.version } });
  const archived = await f.call<Backup>('/export');
  assert.deepEqual(archived.trashItems.find(value => value.id === item.trashItemId)?.item, second);
  assert.deepEqual(archived.trashEntries.find(value => value.id === document.trashEntryId)?.comments, [first]);
  assert.match((await restore({ ...archived, schemaVersion: 49 }, 400)).error!, /schemaVersion 50/);
  const movedArchivePin = structuredClone(archived);
  movedArchivePin.trashItems.find(value => value.id === item.trashItemId)!.item.documentSource!.revisionId = foreignRevision.id;
  await restore(movedArchivePin, 400);

  await restore(archived);
  const exactRevision = active.revisions.find(value => value.id === first.documentSource?.revisionId);
  const revisionPath = `/documents/${source.id}/include-revisions/${first.documentSource!.revisionId}`;
  assert.deepEqual(await other.call<DocRevision>(revisionPath), exactRevision);
  await other.call(`/trash/items/${item.trashItemId}/restore`, { method: 'POST', body: {} }, 409);
  await other.call(`/trash/${document.trashEntryId}/restore`, { method: 'POST', body: {} });
  await other.call(`/trash/items/${item.trashItemId}/restore`, { method: 'POST', body: {} });
  assert.deepEqual(await other.call<Comment[]>(commentsPath(source.id)), [first, second]);
  assert.deepEqual(await other.call<DocRevision>(revisionPath), exactRevision);
  await restore({ ...legacy, schemaVersion: 49 });
  assert.deepEqual(await other.call<Comment[]>(commentsPath(source.id)), []);
});

test('a project-scoped key sees the comment and disclosure-safe source, without a selection write route', async t => {
  const f = await fixture(t);
  const outside = 'project-team';
  const document = await f.create('범위가 제한된 댓글 원문', content(paragraph(quote), {
    type: 'issueSummary', attrs: { projectId: outside, savedViewId: null, label: '외부 프로젝트', groupBy: 'status' },
  }));
  const input = requestFor(document);
  const key = await f.call<ApiKeyCreated>('/api-keys', { method: 'POST', body: { name: '합성 프로젝트 연동', access: 'write', projectIds: [projectId] } }, 201);
  const wideKey = await f.call<ApiKeyCreated>('/api-keys', { method: 'POST', body: { name: '합성 두 프로젝트 연동', access: 'read', projectIds: [projectId, outside] } }, 201);
  const headers = { Authorization: `Bearer ${key.token}` };
  await f.call(`/v1${pathFor(document.id)}`, { method: 'POST', body: input, headers }, 403);
  const { comment } = await f.call<DocumentSelectionCommentResult>(pathFor(document.id), { method: 'POST', body: input }, 201);
  const [projectScoped] = await f.call<Comment[]>(`/v1${commentsPath(document.id)}`, { headers });
  const expected = { ...comment };
  delete expected.documentSource;
  assert.deepEqual(projectScoped, expected);
  assert.deepEqual(await f.call<Comment[]>(`/v1${commentsPath(document.id)}`, { headers: { Authorization: `Bearer ${wideKey.token}` } }), [comment]);
});
