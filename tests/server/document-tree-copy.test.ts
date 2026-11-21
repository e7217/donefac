import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { DOCUMENT_CONTENT_SCHEMA_VERSION } from '../../shared/document-nodes.js';
import { documentSectionHash } from '../../shared/document-sections.js';
import type { Attachment, AttachmentHead, DocPage, DocRevision, DocumentTreeCopyOptions, DocumentTreeCopyPreview, RichContent, WorkspaceSnapshot } from '../../shared/types.js';

const sourceProject = 'project-neo';
const targetProject = 'project-team';
const editor = 'user-min';
const otherActor = 'user-seo';
const path = (id: string) => `/documents/${id}`;
const attachments = (id: string) => `/attachments?${new URLSearchParams({ resourceType: 'document', resourceId: id })}`;
type Backup = WorkspaceSnapshot & { attachments: Attachment[]; revisions: DocRevision[] };

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-document-copy-http-'));
  async function start() {
    const runtime = createApp({ dataDir, outboundWorker: false });
    const server = runtime.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return {
      origin: `http://127.0.0.1:${address.port}`,
      async close() {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        runtime.close();
      },
    };
  }
  let runtime = await start();
  t.after(async () => {
    try { await runtime.close(); }
    finally { rmSync(dataDir, { recursive: true, force: true }); }
  });
  function request(route: string, options: RequestInit = {}) {
    const headers = new Headers(options.headers);
    if (!headers.has('X-Actor-Id')) headers.set('X-Actor-Id', editor);
    return fetch(`${runtime.origin}/api${route}`, { ...options, headers });
  }
  async function call<T>(route: string, status = 200, method = 'GET', input?: unknown, actor = editor) {
    const response = await request(route, {
      method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actor },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const body = await response.text();
    assert.equal(response.status, status, `${method} ${route}: ${body}`);
    return JSON.parse(body) as T;
  }
  async function upload(route: string, filename: string, bytes: Buffer) {
    const response = await request(`${route}&${new URLSearchParams({ filename })}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(bytes),
    });
    const body = await response.text();
    assert.equal(response.status, 201, body);
    return JSON.parse(body) as AttachmentHead;
  }
  return {
    dataDir, request, call, upload,
    get origin() { return runtime.origin; },
    add: (title: string, projectId: string | null = sourceProject, parentId: string | null = null) =>
      call<DocPage>('/documents', 201, 'POST', { title, projectId, parentId, labels: ['설계'], icon: '🧭' }),
    save: (page: DocPage, content: RichContent[]) => call<DocPage>(path(page.id), 200, 'PATCH', {
      expectedVersion: page.version, contentSchemaVersion: DOCUMENT_CONTENT_SCHEMA_VERSION, content: { type: 'doc', content },
    }),
    preview: (page: DocPage, options: DocumentTreeCopyOptions, status = 200) =>
      call<DocumentTreeCopyPreview>(`${path(page.id)}/copy-preview`, status, 'POST', options),
    async expectBytes(url: string, bytes: Buffer) {
      const response = await request(url.replace(/^\/api/u, ''));
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    },
    async restart() {
      await runtime.close();
      runtime = await start();
    },
  };
}

const heading = (sectionId: string): RichContent => ({
  type: 'heading', attrs: { level: 2, sectionId }, content: [{ type: 'text', text: sectionId }],
});
const link = (href: string, text: string): RichContent => ({
  type: 'paragraph', content: [{ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] }],
});
const hrefAt = (page: DocPage, index: number) => page.content.content?.[index].content?.[0].marks?.[0].attrs?.href;

test('document tree copy uses verified current and pinned file bodies, remaps live document links, and commits one retryable tree', async t => {
  const f = await fixture(t);
  const original = await f.add('트리 원본');
  const firstChild = await f.add('먼저 작성한 하위 문서', sourceProject, original.id);
  const secondChild = await f.add('나중에 작성한 하위 문서', sourceProject, original.id);
  const archived = await f.add('휴지통에 보관한 하위 문서', sourceProject, original.id);
  await f.call(`${path(archived.id)}?expectedVersion=${archived.version}`, 200, 'DELETE');
  const destination = await f.add('다른 공간의 상위 문서', targetProject);
  const firstFile = await f.upload(attachments(firstChild.id), '첫 버전.txt', Buffer.from('보관 전 본문'));
  const pinnedBytes = Buffer.from('본문이 가리키는 정확한 버전');
  const pinned = await f.upload(`/attachments/${firstFile.id}/versions?expectedVersionId=${firstFile.currentVersionId}`, '고정 버전.txt', pinnedBytes);
  const latestBytes = Buffer.from('첨부 목록의 최신 버전');
  const oldHref = `/api/attachment-versions/${pinned.currentVersionId}/download`;
  const missingHref = `/api/attachments/${randomUUID()}/content`;
  const outsideHref = `https://example.invalid${oldHref}`;
  const originalRevision = (await f.call<DocRevision[]>(`${path(original.id)}/revisions`))[0];
  const child = await f.save(firstChild, [heading('child-heading')]);
  const source = await f.save(original, [
    heading('own-heading'), link('#own-heading', '이 문서 절'),
    link(`${f.origin}/${documentSectionHash(child.id, 'child-heading', sourceProject)}`, '하위 문서 절'),
    { type: 'documentReference', attrs: { documentId: child.id, label: child.title } },
    { type: 'documentRevisionInclude', attrs: { documentId: original.id, revisionId: originalRevision.id, label: original.title } },
    link(oldHref, '파일 버전'), link(outsideHref, '외부 파일'), link(missingHref, '예전 파일 주소'),
  ]);
  const options: DocumentTreeCopyOptions = {
    title: '복제한 트리', projectId: targetProject, parentId: destination.id, includeDescendants: true, expectedSourceVersion: source.version,
  };
  const beforeFileChange = await f.preview(source, options);
  assert.equal(beforeFileChange.attachmentCount, 1);
  assert.equal(beforeFileChange.warnings.length, 1);
  await f.upload(`/attachments/${firstFile.id}/versions?expectedVersionId=${pinned.currentVersionId}`, '현재 버전.txt', latestBytes);
  const copyPath = `${path(source.id)}/copy`;
  const stale = await f.call<{ details: { reason: string } }>(copyPath, 409, 'POST', {
    ...options, token: beforeFileChange.token, requestId: randomUUID(),
  });
  assert.equal(stale.details.reason, 'copy_preview_stale');
  const preview = await f.preview(source, options);
  assert.deepEqual(preview.documents.map(page => page.id), [source.id, child.id, secondChild.id]);
  assert.deepEqual([preview.attachmentCount, preview.attachmentBytes], [2, pinnedBytes.length + latestBytes.length]);
  const request = { ...options, token: preview.token, requestId: randomUUID() };
  const before = await f.call<Backup>('/export');
  const uploads = () => readdirSync(join(f.dataDir, 'uploads')).sort();
  const beforeFiles = uploads();
  const db = new DatabaseSync(join(f.dataDir, 'teamspace.sqlite'));
  try {
    db.exec("CREATE TRIGGER fail_copy_receipt BEFORE INSERT ON document_creation_requests BEGIN SELECT RAISE(ABORT, 'synthetic document copy receipt failure'); END");
    await f.call(copyPath, 500, 'POST', request);
    const rolledBack = await f.call<Backup>('/export');
    for (const key of ['documents', 'revisions', 'attachments', 'activities'] as const) assert.deepEqual(rolledBack[key], before[key]);
    assert.deepEqual(uploads(), beforeFiles);
    assert.ok(!readdirSync(f.dataDir).some(name => name.startsWith('.append-')));
  } finally {
    db.exec('DROP TRIGGER fail_copy_receipt');
    db.close();
  }

  const root = await f.call<DocPage>(copyPath, 201, 'POST', request);
  assert.equal(root.authorId, editor);
  assert.equal(root.version, 1);
  assert.equal(root.status, 'draft');
  assert.deepEqual([root.projectId, root.parentId, root.title, root.icon, root.labels],
    [targetProject, destination.id, options.title, source.icon, source.labels]);
  const after = await f.call<WorkspaceSnapshot>('/workspace');
  const copiedChildren = after.documents.filter(page => page.parentId === root.id);
  assert.deepEqual(copiedChildren.map(page => page.title), [child.title, secondChild.title]);
  assert.ok(copiedChildren.every(page => page.projectId === targetProject && page.version === 1));
  assert.deepEqual(after.documents.find(page => page.id === source.id), source);
  assert.equal(hrefAt(root, 1), documentSectionHash(root.id, 'own-heading'));
  assert.equal(hrefAt(root, 2), documentSectionHash(copiedChildren[0].id, 'child-heading'));
  assert.equal(root.content.content?.[3].attrs?.documentId, copiedChildren[0].id);
  assert.equal(root.content.content?.[4].attrs?.documentId, original.id);
  assert.equal(root.content.content?.[4].attrs?.revisionId, originalRevision.id);
  assert.equal(hrefAt(root, 6), outsideHref);
  assert.equal(hrefAt(root, 7), missingHref);
  const files = await f.call<AttachmentHead[]>(attachments(copiedChildren[0].id));
  assert.deepEqual(files.map(file => file.filename).sort(), ['고정 버전.txt', '현재 버전.txt']);
  assert.ok(files.every(file => file.resourceId === copiedChildren[0].id && file.id !== pinned.currentVersionId));
  await f.expectBytes(String(hrefAt(root, 5)), pinnedBytes);
  await f.expectBytes(`/attachments/${files.find(file => file.filename === '현재 버전.txt')!.id}/content`, latestBytes);
  assert.equal((await f.call<DocRevision[]>(`${path(root.id)}/revisions`)).length, 1);

  await f.restart();
  assert.deepEqual(await f.call<DocPage>(copyPath, 200, 'POST', request), root);
  await f.call(copyPath, 409, 'POST', request, otherActor);
  await f.call(`${path(child.id)}/copy`, 409, 'POST', request);
  assert.equal((await f.call<WorkspaceSnapshot>('/workspace')).documents.filter(page => page.parentId === destination.id).length, 1);
  await f.expectBytes(String(hrefAt(root, 5)), pinnedBytes);
});

test('a standalone copy can sit under an existing source descendant and keeps links to uncopied pages', async t => {
  const f = await fixture(t);
  const original = await f.add('한 장만 복제할 원본');
  const child = await f.add('원본의 하위 문서', sourceProject, original.id);
  const updated = await f.save(original, [
    { type: 'documentReference', attrs: { documentId: child.id, label: child.title } },
    { type: 'documentReference', attrs: { documentId: original.id, label: original.title } },
  ]);
  const options: DocumentTreeCopyOptions = {
    title: '한 장 복제본', projectId: sourceProject, parentId: child.id, includeDescendants: false, expectedSourceVersion: updated.version,
  };
  await f.preview(updated, { ...options, projectId: targetProject }, 409);
  const preview = await f.preview(updated, options);
  assert.deepEqual(preview.documents.map(page => page.id), [updated.id]);
  assert.equal(preview.attachmentCount, 0);
  const payload = { ...options, token: preview.token, requestId: randomUUID() };
  await f.call(`${path(original.id)}/copy`, 409, 'POST', payload, otherActor);
  const copied = await f.call<DocPage>(`${path(original.id)}/copy`, 201, 'POST', payload);
  assert.equal(copied.parentId, child.id);
  assert.equal(copied.content.content?.[0].attrs?.documentId, child.id);
  assert.equal(copied.content.content?.[1].attrs?.documentId, copied.id);
  const workspace = await f.call<WorkspaceSnapshot>('/workspace');
  assert.ok(!workspace.documents.some(page => page.parentId === copied.id));
  assert.deepEqual(workspace.documents.find(page => page.id === child.id), child);
});
