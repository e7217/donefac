import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { readLegacyArchive } from '../../server/legacy-import-archive.js';
import type { AttachmentHead, DocPage, DocumentPublicationView, RichContent } from '../../shared/types.js';

type Manifest = {
  format: string;
  schemaVersion: number;
  source: 'saved' | 'published';
  scope: { kind: 'space' | 'subtree'; projectId: string | null; documentId: string | null };
  documents: { id: string; title: string; path: string; parentId: string | null; originalParentId: string | null;
    version: number; revisionId: string | null; publishedAt: string | null }[];
  attachments: { id: string; attachmentId: string; documentId: string; filename: string; path: string; size: number; sha256: string }[];
  diagnostics: { documentId: string; code: string; nodeType: string; message: string }[];
};

const author = 'user-min';
const reviewer = 'user-seo';
const project = 'project-neo';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=', 'base64');
const newerBytes = Buffer.from('%PDF-1.6\n% newer synthetic fixture\n');
const paragraph = (text: string, href?: string): RichContent => ({ type: 'paragraph', content: [{ type: 'text', text,
  ...(href ? { marks: [{ type: 'link', attrs: { href } }] } : {}) }] });
const document = (...content: RichContent[]): RichContent => ({ type: 'doc', content });
const reference = (documentId: string, label: string): RichContent => ({ type: 'documentReference', attrs: { documentId, label } });
const image = (id: string): RichContent => ({ type: 'image', attrs: { src: `/api/attachments/${id}/content?inline=1`, alt: '당시 사진' } });
const exportPath = (query: Record<string, string>) => `/document-exports/markdown.zip?${new URLSearchParams(query)}`;

async function asJson<T>(response: Response, expected = 200) {
  const body = await response.text();
  assert.equal(response.status, expected, body);
  return JSON.parse(body) as T;
}

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'donefac-document-offline-export-'));
  const runtime = createApp({ dataDir: directory, outboundWorker: false });
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    try { await new Promise<void>(resolve => server.close(() => resolve())); }
    finally { runtime.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const request = (path: string, method = 'GET', value?: unknown, actor = author) => fetch(url + path, {
    method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actor }, ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  const edit = async (page: DocPage, updates: Partial<DocPage>) => asJson<DocPage>(await request(`/documents/${page.id}`, 'PATCH', {
    expectedVersion: page.version, ...updates,
  }));
  const subtree = (id: string, source: Manifest['source'] = 'saved') => request(exportPath({ scope: 'subtree', documentId: id, source }));
  const upload = async (path: string, bytes: Buffer) => asJson<AttachmentHead>(await fetch(url + path, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': author }, body: new Uint8Array(bytes),
  }), 201);
  return {
    directory, origin: new URL(url).origin, request, edit, subtree,
    async page(title: string, fields: Partial<DocPage> = {}) {
      return asJson<DocPage>(await request('/documents', 'POST', { title, projectId: project, content: document(paragraph(title)), ...fields }), 201);
    },
    attach(page: DocPage, filename: string, bytes: Buffer) {
      return upload(`/attachments?${new URLSearchParams({ resourceType: 'document', resourceId: page.id, filename })}`, bytes);
    },
    append(base: AttachmentHead, filename: string, bytes: Buffer) {
      return upload(`/attachments/${base.id}/versions?${new URLSearchParams({ expectedVersionId: base.currentVersionId, filename })}`, bytes);
    },
    async publish(page: DocPage) {
      const path = `/documents/${page.id}/publication`;
      const before = await asJson<DocumentPublicationView>(await request(path));
      const pending = await asJson<DocumentPublicationView>(await request(path, 'POST', { action: 'request', expectedVersion: before.version,
        expectedDocumentVersion: page.version, workspaceGeneration: before.workspaceGeneration, reviewerId: reviewer, note: '' }));
      const state = await asJson<DocumentPublicationView>(await request(path, 'POST', { action: 'publish', expectedVersion: pending.version,
        workspaceGeneration: pending.workspaceGeneration, revisionId: pending.review?.revisionId, note: '' }, reviewer));
      assert.ok(state.published);
      return state.published;
    },
  };
}

async function unzip(response: Response) {
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200, response.ok ? '' : bytes.toString());
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(Number(response.headers.get('content-length')), bytes.length);
  assert.match(response.headers.get('content-disposition') ?? '', /filename\*=UTF-8''.*\.zip/);
  const { files } = await readLegacyArchive(bytes, 'offline.zip');
  const text = (path: string) => { const entry = files.get(path); assert.ok(entry, path); return entry.toString('utf8'); };
  const manifest: Manifest = JSON.parse(text('manifest.json'));
  assert.equal(manifest.format, 'donefac-document-markdown');
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(files.size, manifest.documents.length + manifest.attachments.length + 2);
  return { files, text, manifest };
}

function href(from: string, to: string, fragment?: string) {
  return posix.relative(posix.dirname(from), to).split('/').map(encodeURIComponent).join('/') + (fragment ? `#${fragment}` : '');
}

test('offline Markdown subtree keeps portable Korean paths, scoped section links and exact pinned attachments', async t => {
  const f = await fixture(t);
  let root = await f.page('운영 가이드 [검토]');
  const section = 'install-01';
  const first = await f.page('설치 절차', { parentId: root.id, content: document({ type: 'heading', attrs: { level: 2, sectionId: section },
    content: [{ type: 'text', text: '도구 설치' }] }, paragraph('설치 내용')) });
  const second = await f.page('설치 절차', { parentId: root.id });
  const removed = await f.page('휴지통 내부 원문', { parentId: root.id });
  const outside = await f.page('다른 프로젝트 비공개 본문', { projectId: 'project-team' });
  const outsideFile = await f.attach(outside, '범위 밖.bin', Buffer.from('타 프로젝트 파일 바이트'));
  const common = await f.page('공통 공간 안내', { projectId: null });
  const base = await f.attach(root, '개정 전 사진.png', png);
  const head = await f.append(base, '개정 후 문서.pdf', newerBytes);
  root = await f.edit(root, { content: document(paragraph('저장된 원문'), reference(first.id, '설치 절차 보기'),
    paragraph('설치 제목으로 이동', `${f.origin}/#/${project}/documents/${first.id}?section=${section}`), reference(outside.id, '프로젝트 바깥 참조'),
    paragraph('다른 문서의 파일', `/api/attachments/${outsideFile.id}/content`),
    paragraph('외부 안내', 'https://offline-test.invalid/guide'),
    { type: 'issueList', attrs: { projectId: project, label: '팀 업무 목록' } }, image(base.id)) });
  await asJson(await f.request(`/documents/${removed.id}`, 'DELETE'));

  const { files, text, manifest } = await unzip(await f.subtree(root.id));
  assert.deepEqual(manifest.scope, { kind: 'subtree', projectId: project, documentId: root.id });
  assert.deepEqual(new Set(manifest.documents.map(item => item.id)), new Set([root.id, first.id, second.id]));
  const [rootEntry] = manifest.documents;
  assert.equal(rootEntry.id, root.id);
  assert.equal(rootEntry.version, root.version);
  assert.equal(rootEntry.parentId, null);
  const children = manifest.documents.slice(1);
  assert.ok(children.every(item => item.title === '설치 절차' && item.parentId === root.id));
  assert.notEqual(children[0].path, children[1].path);
  const firstEntry = children.find(item => item.id === first.id)!;
  const rootText = text(rootEntry.path);
  assert.ok(rootText.includes(`(${href(rootEntry.path, firstEntry.path)})`));
  assert.ok(rootText.includes(`(${href(rootEntry.path, firstEntry.path, section)})`));
  assert.ok(text(firstEntry.path).includes(`id="${section}"`));
  assert.doesNotMatch(rootText, /#\/project-|\/api\/attachments|offline-test\.invalid|다른 프로젝트 비공개 본문/);
  assert.ok(text('README.md').includes('  - [설치 절차]'));
  assert.equal(manifest.attachments.length, 2);
  for (const entry of manifest.attachments) {
    const expected = entry.id === base.id ? png : newerBytes;
    assert.equal(entry.attachmentId, base.id);
    assert.equal(entry.documentId, root.id);
    assert.equal(entry.size, expected.length);
    assert.equal(entry.sha256, createHash('sha256').update(expected).digest('hex'));
    assert.deepEqual(files.get(entry.path), expected);
    assert.ok(rootText.includes(`(${href(rootEntry.path, entry.path)})`));
  }
  assert.ok(manifest.attachments.some(entry => entry.id === head.currentVersionId));
  assert.ok(manifest.diagnostics.some(item => item.documentId === root.id && item.code === 'dynamic_block'));
  assert.ok(manifest.diagnostics.some(item => item.documentId === root.id && item.code === 'external_link'));
  const commonExport = await unzip(await f.request(exportPath({ scope: 'space', source: 'saved' })));
  assert.deepEqual(commonExport.manifest.documents.map(item => item.id), [common.id]);
  const space = await unzip(await f.request(exportPath({ scope: 'space', projectId: project, source: 'saved' })));
  assert.ok(space.manifest.documents.some(item => item.id === root.id));
  assert.ok(!space.manifest.documents.some(item => [common.id, removed.id, outside.id].includes(item.id)));
});

test('approved Markdown uses frozen bodies and only referenced bytes through an unpublished tree branch', async t => {
  const f = await fixture(t);
  let root = await f.page('승인 당시 제목');
  const intermediate = await f.page('미승인 중간 제목', { parentId: root.id });
  const child = await f.page('승인된 손자', { parentId: intermediate.id });
  const sharedOnly = await f.page('공유 표시만 한 초안', { parentId: root.id, status: 'published' });
  const oldImage = await f.attach(root, '승인 사진.png', png);
  root = await f.edit(root, { content: document(paragraph('승인 당시 본문'), image(oldImage.id), reference(child.id, '승인된 하위 문서')) });
  const before = await f.publish(root);
  await f.publish(child);
  const head = await f.append(oldImage, '승인 뒤 교체한 파일.pdf', newerBytes);
  await f.attach(root, '승인 뒤 별도 첨부.bin', Buffer.from('미승인 데이터'));
  await f.edit(root, { title: '공유할 수 없는 새 초안 제목', content: document(paragraph('새로 저장한 미승인 본문')) });

  const { files, text, manifest } = await unzip(await f.subtree(root.id, 'published'));
  assert.equal(manifest.source, 'published');
  assert.deepEqual(manifest.documents.map(item => item.id), [root.id, child.id]);
  const [rootEntry, childEntry] = manifest.documents;
  assert.equal(rootEntry.title, '승인 당시 제목');
  assert.equal(rootEntry.revisionId, before.revisionId);
  assert.equal(rootEntry.publishedAt, before.publishedAt);
  assert.equal(childEntry.parentId, root.id);
  assert.equal(childEntry.originalParentId, intermediate.id);
  assert.match(text(rootEntry.path), /승인 당시 본문/);
  assert.ok(text(rootEntry.path).includes(`(${href(rootEntry.path, childEntry.path)})`));
  assert.deepEqual(manifest.attachments.map(item => item.id), [oldImage.id]);
  assert.deepEqual(files.get(manifest.attachments[0].path), png);
  const metadataAndMarkdown = [...files].filter(([path]) => !path.startsWith('attachments/')).map(([, bytes]) => bytes.toString('utf8')).join('\n');
  assert.doesNotMatch(metadataAndMarkdown, /미승인 본문|새 초안 제목|미승인 중간 제목|교체한 파일|별도 첨부/);
  assert.equal((await f.subtree(sharedOnly.id, 'published')).status, 404);
  const saved = await unzip(await f.subtree(root.id));
  assert.match(saved.text(saved.manifest.documents[0].path), /새로 저장한 미승인 본문/);
  assert.ok(saved.manifest.attachments.some(item => item.id === head.currentVersionId));
});

test('offline ZIP rejects ambiguous scope and returns JSON before sending corrupt attachment bytes', async t => {
  const f = await fixture(t);
  const root = await f.page('파일 오류가 있는 문서');
  for (const query of [
    { scope: 'subtree', source: 'saved', documentId: root.id, projectId: project },
    { scope: 'space', source: 'saved', documentId: root.id },
    { scope: 'space', source: 'draft' },
  ]) {
    const result = await f.request(exportPath(query as Record<string, string>));
    await asJson(result, 400);
    assert.equal(result.headers.get('content-disposition'), null);
  }
  await asJson(await f.subtree('missing-document'), 404);
  await asJson(await f.request(exportPath({ scope: 'space', source: 'saved', projectId: 'missing-project' })), 404);
  const attachment = await f.attach(root, '해시 확인.png', png);
  await unzip(await f.subtree(root.id));
  writeFileSync(join(f.directory, 'uploads', attachment.id), Buffer.from('내용이 손상됐습니다'));
  const corrupt = await f.subtree(root.id);
  const error = await asJson<{ error: string }>(corrupt, 503);
  assert.match(error.error, /첨부파일/);
  assert.equal(corrupt.headers.get('content-disposition'), null);
  assert.match(corrupt.headers.get('content-type') ?? '', /^application\/json/);
});
