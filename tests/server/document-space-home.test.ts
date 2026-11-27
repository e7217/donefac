import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { DocPage, DocumentSpaceHome, DocumentTreeMovePreview, WorkspaceSnapshot } from '../../shared/types.js';

const project = 'project-neo';
const otherProject = 'project-team';
const path = (space: string | null = project) => '/document-space-home' + (space === null ? '' : `?projectId=${space}`);
const docPath = (documentId: string) => `/documents/${documentId}`;

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'donefac-space-home-'));
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
  async function call<T = unknown>(url: string, method = 'GET', body?: unknown, status = 200, actorId = 'user-min') {
    const response = await fetch(origin + url, {
      method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actorId },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.text();
    assert.equal(response.status, status, `${method} ${url}: ${json}`);
    return JSON.parse(json) as T;
  }
  const workspace = () => call<WorkspaceSnapshot>('/workspace');
  return {
    call, workspace,
    add: (title: string, projectId: string | null, parentId: string | null = null) =>
      call<DocPage>('/documents', 'POST', { title, projectId, parentId, content: { type: 'doc', content: [{ type: 'paragraph' }] } }, 201),
    async set(space: string | null, documentId: string | null, expectedVersion: number, status = 200, actorId = 'user-min') {
      const { restoreGeneration } = await workspace();
      return call<DocumentSpaceHome>(path(space), 'PATCH', { documentId, expectedVersion, restoreGeneration }, status, actorId);
    },
    get: (space: string | null) => call<DocumentSpaceHome>(path(space)),
    async move(id: string, projectId: string | null, parentId: string | null = null) {
      const { token } = await call<DocumentTreeMovePreview>(`${docPath(id)}/move-preview`, 'POST', { projectId, parentId });
      return call<DocumentTreeMovePreview>(`${docPath(id)}/move`, 'POST', { projectId, parentId, token });
    },
  };
}

test('space homes use active same-space documents and compare the saved workspace setting', async t => {
  const f = await fixture(t);
  const first = await f.add('프로젝트 공간 홈', project);
  const second = await f.add('두 번째 프로젝트 홈', project);
  const common = await f.add('팀 공간 홈', null);
  assert.deepEqual(await f.get(project), { projectId: project, documentId: null, version: 0 });
  assert.deepEqual(await f.get(null), { projectId: null, documentId: null, version: 0 });
  await f.set(project, common.id, 0, 422);
  await f.set(null, first.id, 0, 422);
  const selected = await f.set(project, first.id, 0);
  const selectedCommon = await f.set(null, common.id, 0);
  assert.deepEqual(await f.set(project, first.id, 1), selected);
  assert.deepEqual(await f.set(project, second.id, 1, 200, 'user-seo'), { projectId: project, documentId: second.id, version: 2 });
  await f.set(project, null, 1, 409);
  assert.deepEqual((await f.workspace()).documentSpaceHomes, [selectedCommon, { projectId: project, documentId: second.id, version: 2 }]);
  assert.deepEqual(await f.set(project, null, 2), { projectId: project, documentId: null, version: 3 });
  assert.deepEqual(await f.get(null), selectedCommon);
  await f.call(path('does-not-exist'), 'GET', undefined, 404);
});

test('a same-space reparent preserves the configured page and a move or trash clears the old setting', async t => {
  const f = await fixture(t);
  const folder = await f.add('옮길 폴더', project);
  const saved = await f.add('하위 공간 홈', project, folder.id);
  const alternative = await f.add('새 상위 문서', project);
  await f.set(project, saved.id, 0);
  await f.move(folder.id, project, alternative.id);
  assert.deepEqual(await f.get(project), { projectId: project, documentId: saved.id, version: 1 });
  await f.move(folder.id, otherProject);
  assert.deepEqual(await f.get(project), { projectId: project, documentId: null, version: 2 });
  assert.deepEqual(await f.get(otherProject), { projectId: otherProject, documentId: null, version: 0 });
  await f.set(otherProject, saved.id, 0);
  const { trashEntryId } = await f.call<{ trashEntryId: string }>(docPath(saved.id), 'DELETE');
  assert.deepEqual(await f.get(otherProject), { projectId: otherProject, documentId: null, version: 2 });
  await f.set(otherProject, saved.id, 2, 422);
  await f.call(`/trash/${trashEntryId}/restore`, 'POST', {});
  assert.deepEqual(await f.get(otherProject), { projectId: otherProject, documentId: null, version: 2 });
  await f.set(otherProject, saved.id, 2);
  const restored = (await f.workspace()).documents.find(value => value.id === saved.id)!;
  // A legacy page update can also move a leaf across spaces without using the tree move route.
  await f.call(docPath(saved.id), 'PATCH', { expectedVersion: restored.version, projectId: null, parentId: null });
  assert.deepEqual(await f.get(otherProject), { projectId: otherProject, documentId: null, version: 4 });
  assert.deepEqual(await f.get(null), { projectId: null, documentId: null, version: 0 });
});

test('native backup restores configured homes, rejects mismatched scope, and fences stale saves', async t => {
  const f = await fixture(t);
  const saved = await f.add('백업 홈', project);
  const common = await f.add('백업 공통 홈', null);
  const home = await f.set(project, saved.id, 0);
  await f.set(null, common.id, 0);
  const generation = (await f.workspace()).restoreGeneration;
  type Backup = WorkspaceSnapshot & { schemaVersion: number; documentSpaceHomes: DocumentSpaceHome[] };
  const backup = await f.call<Backup>('/export');
  assert.ok(backup.schemaVersion >= 128);
  assert.ok(backup.documentSpaceHomes.some(entry => entry.documentId === common.id));
  const wrong = { ...backup, documentSpaceHomes: [{ ...home, documentId: common.id }] };
  await f.call('/import', 'POST', { data: wrong }, 400);
  assert.deepEqual(await f.get(project), home);
  await f.call('/import', 'POST', { data: { ...backup, documentSpaceHomes: [home, home] } }, 400);
  await f.set(project, null, 1);
  await f.call('/import', 'POST', { data: backup });
  assert.deepEqual(await f.get(project), home);
  await f.call(path(), 'PATCH', { expectedVersion: home.version, documentId: null, restoreGeneration: generation }, 409);
  const legacy: Partial<Backup> = { ...backup, schemaVersion: 127 };
  delete legacy.documentSpaceHomes;
  await f.call('/import', 'POST', { data: legacy });
  assert.deepEqual(await f.get(project), { projectId: project, documentId: null, version: 0 });
  assert.deepEqual(await f.get(null), { projectId: null, documentId: null, version: 0 });
});
