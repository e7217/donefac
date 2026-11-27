import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { CollaborationSession } from '../../shared/collaboration.js';
import type { DocPage, DocRevision, WorkspaceSnapshot } from '../../shared/types.js';

const content = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'donefac-document-revision-restore-'));
  const runtime = createApp({ dataDir, outboundWorker: false });
  const server = runtime.app.listen(0, '127.0.0.1');
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
  const origin = `http://127.0.0.1:${address.port}/api`;
  async function call<T = unknown>(path: string, method = 'GET', body?: unknown, status = 200, actorId = 'user-min') {
    const response = await fetch(origin + path, {
      method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actorId },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${json}`);
    return JSON.parse(json) as T;
  }
  const document = await call<DocPage>('/documents', 'POST', { title: '복구 검증 원본', projectId: 'project-neo', content: content('보관한 본문') }, 201);
  const path = `/documents/${document.id}`;
  const [original] = await call<DocRevision[]>(`${path}/revisions`);
  const saved = await call<DocPage>(path, 'PATCH', { expectedVersion: document.version, title: '현재 제목', content: content('현재 본문') });
  const workspace = () => call<WorkspaceSnapshot>('/workspace');
  const { restoreGeneration } = await workspace();
  assert.ok(restoreGeneration);
  return { call, path, original, saved, workspace, restoreGeneration };
}

test('a version restore records one revision and one collaboration reset, and replays the approved result after further edits', async t => {
  const f = await fixture(t);
  const session = await f.call<CollaborationSession>(`${f.path}/collaboration/enable`, 'POST', { expectedVersion: f.saved.version });
  const request = { expectedVersion: session.document.version, expectedRestoreGeneration: f.restoreGeneration,
    requestId: randomUUID(), revisionId: f.original.id };
  const restorePath = `${f.path}/restore`;
  const [first, replayed] = await Promise.all([f.call<DocPage>(restorePath, 'POST', request), f.call<DocPage>(restorePath, 'POST', request)]);
  assert.deepEqual(first, replayed);
  assert.equal(first.title, f.original.title);
  assert.equal(first.plainText, f.original.plainText);
  assert.equal(first.version, request.expectedVersion + 1);
  const replaced = await f.call<CollaborationSession>(`${f.path}/collaboration`);
  assert.notEqual(replaced.epoch, session.epoch);
  const peer = await f.call<DocPage>(f.path, 'PATCH', { expectedVersion: first.version, title: '복구 후 팀원 제목' }, 200, 'user-seo');
  assert.deepEqual(await f.call<DocPage>(restorePath, 'POST', request), first);
  await f.call(restorePath, 'POST', { ...request, revisionId: randomUUID() }, 409);
  await f.call(restorePath, 'POST', { ...request, requestId: randomUUID() }, 409);
  await f.call(restorePath, 'POST', request, 409, 'user-seo');
  await f.call(f.path, 'PATCH', request, 409);

  const current = await f.call<CollaborationSession>(`${f.path}/collaboration`);
  assert.equal(current.epoch, replaced.epoch);
  assert.deepEqual(current.document, peer);
  const revisions = await f.call<DocRevision[]>(`${f.path}/revisions`);
  assert.equal(revisions.filter(revision => revision.summary === '버전 1에서 복구').length, 1);
  assert.equal((await f.workspace()).activities.filter(activity => activity.resourceId === first.id && activity.action === '문서 복구').length, 1);
});

test('a pending version restore from before a workspace replacement is rejected even when document and revision versions match', async t => {
  const f = await fixture(t);
  const request = { expectedVersion: f.saved.version, expectedRestoreGeneration: f.restoreGeneration,
    requestId: randomUUID(), revisionId: f.original.id };
  const backup = await f.call('/export');
  const { trashEntryId } = await f.call<{ trashEntryId: string }>(f.path, 'DELETE');
  await f.call(`/trash/${trashEntryId}`, 'DELETE');
  await f.call('/import', 'POST', { data: backup });
  const snapshot = await f.workspace();
  assert.notEqual(snapshot.restoreGeneration, request.expectedRestoreGeneration);
  assert.equal(snapshot.documents.find(document => document.id === f.saved.id)?.version, request.expectedVersion);
  assert.ok((await f.call<DocRevision[]>(`${f.path}/revisions`)).some(revision => revision.id === request.revisionId));
  await f.call(`${f.path}/restore`, 'POST', request, 409);
  assert.equal((await f.workspace()).documents.find(document => document.id === f.saved.id)?.plainText, f.saved.plainText);
  const restored = await f.call<DocPage>(`${f.path}/restore`, 'POST', { ...request, expectedRestoreGeneration: snapshot.restoreGeneration });
  assert.equal(restored.plainText, f.original.plainText);
});
