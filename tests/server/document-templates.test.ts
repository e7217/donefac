import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { DOCUMENT_CONTENT_SCHEMA_VERSION } from '../../shared/document-nodes.js';
import { documentSectionHash } from '../../shared/document-sections.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type { Attachment, AttachmentHead, DocPage, DocRevision, DocumentTemplate, DocumentTemplateSummary, RichContent, WorkspaceSnapshot } from '../../shared/types.js';

const editor = 'user-min';
const teammate = 'user-seo';
const project = 'project-neo';
const otherProject = 'project-team';
const resource = '/document-templates';
type Backup = WorkspaceSnapshot & {
  schemaVersion: number;
  attachments: Attachment[];
  documentTemplates: DocumentTemplate[];
  documentTemplateAssets: { id: string; templateId: string; filename: string; mimeType: string; size: number; sha256: string; data: string }[];
  revisions: DocRevision[];
};
type Failure = { error: string; details: { reason: string; currentVersion?: number } };

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-document-templates-'));
  const runtime = createApp({ dataDir, outboundWorker: false });
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  function request(path: string, options?: RequestInit) {
    const headers = new Headers(options?.headers);
    if (!headers.has('X-Actor-Id')) headers.set('X-Actor-Id', editor);
    return fetch(`${origin}/api${path}`, { ...options, headers });
  }
  async function call<T = unknown>(path: string, status = 200, method = 'GET', data?: unknown, actorId = editor) {
    const response = await request(path, {
      method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actorId },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const value = await response.json() as T;
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  }
  return { call, request, origin, dataDir };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function paragraph(text: string): RichContent {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

function createSource(f: Fixture, title: string, projectId: string | null, content = paragraph(title)) {
  return f.call<DocPage>('/documents', 201, 'POST', { title, projectId, content, icon: '🧭' });
}

function captureRequest(source: DocPage, name: string) {
  return { requestId: randomUUID(), sourceDocumentId: source.id, expectedDocumentVersion: source.version, name };
}

function draftRequest(template: DocumentTemplateSummary, projectId = template.projectId, parentId: string | null = null) {
  return { requestId: randomUUID(), templateId: template.id, expectedTemplateVersion: template.version, title: '템플릿으로 만든 문서', projectId, parentId };
}

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=', 'base64');
const documentFiles = (document: DocPage) => `/attachments?${new URLSearchParams({ resourceType: 'document', resourceId: document.id })}`;
const contentPath = (id: string) => `/attachments/${id}/content`;
const fileLink = (href: string, text: string): RichContent => ({
  type: 'paragraph', content: [{ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] }],
});

async function upload(f: Fixture, path: string, bytes: Buffer) {
  const response = await f.request(path, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(bytes),
  });
  const body = await response.text();
  assert.equal(response.status, 201, body);
  return JSON.parse(body) as AttachmentHead;
}

function addFile(f: Fixture, document: DocPage, filename: string, bytes: Buffer) {
  return upload(f, `${documentFiles(document)}&${new URLSearchParams({ filename })}`, bytes);
}

function appendFile(f: Fixture, attachment: AttachmentHead, filename: string, bytes: Buffer) {
  const query = new URLSearchParams({ expectedVersionId: attachment.currentVersionId, filename });
  return upload(f, `/attachments/${attachment.id}/versions?${query}`, bytes);
}

function saveBlocks(f: Fixture, document: DocPage, content: RichContent[]) {
  return f.call<DocPage>(`/documents/${document.id}`, 200, 'PATCH', {
    expectedVersion: document.version, contentSchemaVersion: DOCUMENT_CONTENT_SCHEMA_VERSION, content: { type: 'doc', content },
  });
}

async function purgeDocument(f: Fixture, document: DocPage) {
  const { trashEntryId } = await f.call<{ trashEntryId: string }>(`/documents/${document.id}?expectedVersion=${document.version}`, 200, 'DELETE');
  await f.call(`/trash/${trashEntryId}`, 200, 'DELETE');
}

async function expectBytes(f: Fixture, path: string, bytes: Buffer) {
  const response = await f.request(path);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
}

test('template previews read the exact saved body only in an allowed destination and never make a draft', async t => {
  const f = await fixture(t);
  const source = await createSource(f, '프로젝트 인수인계 저장본', project);
  const common = await createSource(f, '팀 공통 인수인계 저장본', null);
  const template = await f.call<DocumentTemplateSummary>(resource, 201, 'POST', captureRequest(source, '프로젝트 인수인계'));
  const team = await f.call<DocumentTemplateSummary>(resource, 201, 'POST', captureRequest(common, '팀 공통 인수인계'));
  const updatedSource = await saveBlocks(f, source, paragraph('템플릿 저장 뒤 원본에 추가한 내용').content!);
  const previewPath = (summary: DocumentTemplateSummary, projectId = summary.projectId, version = summary.version) => (
    `${resource}/${summary.id}/preview?${new URLSearchParams({ expectedVersion: String(version), ...(projectId === null ? {} : { projectId }) })}`
  );
  const before = await f.call<WorkspaceSnapshot>('/workspace');
  const preview = await f.request(previewPath(template), { headers: { 'X-Actor-Id': teammate } });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await preview.json(), { id: template.id, version: template.version, content: source.content });
  assert.deepEqual(await f.call(previewPath(team, otherProject)), { id: team.id, version: team.version, content: common.content });
  assert.equal((await f.call<Failure>(previewPath(template, otherProject), 404)).details.reason, 'template_not_found');
  assert.equal((await f.call<Failure>(previewPath(template, null), 404)).details.reason, 'template_not_found');
  await f.call(previewPath(team, randomUUID()), 404);
  await f.call(`${resource}/${template.id}/preview`, 400);
  await f.call(`${previewPath(template)}&expectedVersion=2`, 400);
  await f.call(`${previewPath(template)}&includeArchived=1`, 400);
  assert.deepEqual(await f.call('/workspace'), before);

  const updated = await f.call<DocumentTemplateSummary>(`${resource}/${template.id}`, 200, 'PATCH', {
    expectedVersion: template.version, sourceDocumentId: updatedSource.id, expectedDocumentVersion: updatedSource.version,
  });
  assert.equal((await f.call<Failure>(previewPath(template), 409)).details.reason, 'template_version_conflict');
  assert.deepEqual(await f.call(previewPath(updated)), { id: updated.id, version: updated.version, content: updatedSource.content });
  const archived = await f.call<DocumentTemplateSummary>(`${resource}/${team.id}`, 200, 'PATCH', { expectedVersion: team.version, archived: true });
  assert.equal((await f.call<Failure>(previewPath(archived, project), 409)).details.reason, 'template_archived');
});

test('team and project templates capture portable saved content and create an independent revision once', async t => {
  const f = await fixture(t);
  const common = await createSource(f, '팀 회의 양식', null);
  let source = await createSource(f, '프로젝트 회의 양식', project);
  const heading = 'agenda';
  const section = documentSectionHash(source.id, heading, project);
  const link = (href: string) => ({ type: 'text', text: '본문으로 이동', marks: [{ type: 'link', attrs: { href } }] });
  const formatted: RichContent = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2, sectionId: heading }, content: [{ type: 'text', text: '원래 회의 안건' }] },
    { type: 'paragraph', content: [link(section)] }, { type: 'paragraph', content: [link(documentSectionHash(common.id, heading))] },
    { type: 'image', attrs: { src: 'https://assets.example.test/logo.png', alt: '팀 로고' } },
  ] };
  source = await f.call<DocPage>(`/documents/${source.id}`, 200, 'PATCH', { expectedVersion: source.version, content: formatted });
  const commonTemplate = await f.call<DocumentTemplateSummary>(resource, 201, 'POST', captureRequest(common, 'Weekly'));
  const register = captureRequest(source, 'Weekly');
  const template = await f.call<DocumentTemplateSummary>(resource, 201, 'POST', register);
  assert.deepEqual(await f.call(resource, 200, 'POST', register), template);
  assert.match((await f.call<Failure>(resource, 409, 'POST', captureRequest(source, 'weekly'))).details.reason, /name/);
  assert.equal(template.sourceVersion, source.version);
  assert.ok(!Object.hasOwn(template, 'content'));
  const listIds = async (query = '') => (await f.call<DocumentTemplateSummary[]>(resource + query)).map(value => value.id).sort();
  assert.deepEqual(await listIds(), [commonTemplate.id]);
  assert.deepEqual(await listIds(`?projectId=${project}`), [commonTemplate.id, template.id].sort());
  assert.deepEqual(await listIds(`?projectId=${otherProject}`), [commonTemplate.id]);
  await f.call('/documents', 404, 'POST', draftRequest(template, otherProject));
  const parent = await createSource(f, '다른 프로젝트 문서', otherProject);
  await f.call('/documents', 400, 'POST', draftRequest(commonTemplate, project, parent.id));
  assert.equal((await f.call<DocPage>('/documents', 201, 'POST', draftRequest(commonTemplate, otherProject, parent.id))).parentId, parent.id);

  source = await f.call<DocPage>(`/documents/${source.id}`, 200, 'PATCH', {
    expectedVersion: source.version, content: paragraph('바뀐 원본'), contentSchemaVersion: DOCUMENT_CONTENT_SCHEMA_VERSION,
  });
  const removed = await f.call<{ trashEntryId: string }>(`/documents/${source.id}?expectedVersion=${source.version}`, 200, 'DELETE');
  await f.call(`/trash/${removed.trashEntryId}`, 200, 'DELETE');
  const request = draftRequest(template);
  const workspace = await f.call<WorkspaceSnapshot>('/workspace');
  const db = new DatabaseSync(join(f.dataDir, 'teamspace.sqlite'));
  try {
    db.exec(`CREATE TRIGGER fail_template_receipt BEFORE INSERT ON document_creation_requests
      BEGIN SELECT RAISE(ABORT, 'synthetic template receipt failure'); END`);
    await f.call('/documents', 500, 'POST', request, teammate);
    assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).documents, workspace.documents);
  } finally {
    db.exec('DROP TRIGGER fail_template_receipt');
    db.close();
  }
  const first = await f.call<DocPage>('/documents', 201, 'POST', request, teammate);
  const retry = await f.call<DocPage>('/documents', 200, 'POST', request, teammate);
  assert.deepEqual(retry, first);
  assert.equal(first.status, 'draft');
  assert.equal(first.authorId, teammate);
  assert.equal(first.icon, '🧭');
  assert.match(first.plainText, /원래 회의 안건/);
  assert.doesNotMatch(first.plainText, /바뀐 원본/);
  const [ownLink, otherLink] = [1, 2].map(index => first.content.content?.[index].content?.[0].marks?.[0].attrs?.href);
  assert.equal(ownLink, documentSectionHash(first.id, heading));
  assert.equal(otherLink, documentSectionHash(common.id, heading));
  await f.call('/documents', 409, 'POST', request, editor);
  const backup = await f.call<Backup>('/export');
  const revisions = backup.revisions.filter(value => value.documentId === first.id);
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].version, 1);
  assert.deepEqual(revisions[0].content, first.content);
  assert.match(revisions[0].summary, /Weekly/);
  assert.equal(backup.activities.filter(value => value.resourceId === first.id && value.action === '문서 생성').length, 1);
});

test('template edits, source replacement, and archive use versions without changing earlier drafts', async t => {
  const f = await fixture(t);
  const source = await createSource(f, '첫 양식', project);
  const replacement = await createSource(f, '바뀐 양식', project);
  const foreign = await createSource(f, '다른 공간 양식', otherProject);
  const capture = captureRequest(source, '회의 양식');
  const invalidSource = { ...capture, expectedDocumentVersion: source.version + 1 };
  const staleSource = await f.call<Failure>(resource, 409, 'POST', invalidSource);
  assert.equal(staleSource.details.currentVersion, source.version);
  const template = await f.call<DocumentTemplateSummary>(resource, 201, 'POST', capture);
  const earlier = await f.call<DocPage>('/documents', 201, 'POST', draftRequest(template));
  const path = `${resource}/${template.id}`;
  const replace = (page: DocPage) => ({ sourceDocumentId: page.id, expectedDocumentVersion: page.version });
  await f.call(path, 400, 'PATCH', { expectedVersion: template.version, ...replace(foreign) });
  const revised = await f.call<DocumentTemplateSummary>(path, 200, 'PATCH', {
    expectedVersion: template.version, name: '개정 회의 양식', ...replace(replacement),
  }, teammate);
  assert.equal(revised.version, template.version + 1);
  assert.equal(revised.sourceDocumentId, replacement.id);
  assert.equal(revised.updatedBy, teammate);
  await f.call(path, 409, 'PATCH', { expectedVersion: template.version, archived: true });
  const stale = await f.call<Failure>('/documents', 409, 'POST', draftRequest(template));
  assert.equal(stale.details.reason, 'template_version_conflict');
  assert.equal(stale.details.currentVersion, revised.version);
  const reviewed = draftRequest(revised);
  const later = await f.call<DocPage>('/documents', 201, 'POST', reviewed);
  assert.equal(earlier.plainText, source.plainText);
  assert.equal(later.plainText, replacement.plainText);
  assert.notEqual(later.id, earlier.id);

  const archived = await f.call<DocumentTemplateSummary>(path, 200, 'PATCH', { expectedVersion: revised.version, archived: true });
  assert.ok(archived.archived);
  assert.deepEqual(await f.call(`${resource}?projectId=${project}`), []);
  assert.deepEqual(await f.call(`${resource}?projectId=${project}&includeArchived=1`), [archived]);
  assert.equal((await f.call<Failure>('/documents', 409, 'POST', draftRequest(archived))).details.reason, 'template_archived');
  assert.equal((await f.call<DocPage>('/documents', 200, 'POST', reviewed)).id, later.id);
  const restored = await f.call<DocumentTemplateSummary>(path, 200, 'PATCH', { expectedVersion: archived.version, archived: false });
  assert.deepEqual(await f.call(`${resource}?projectId=${project}`), [restored]);
});

test('saved templates copy inline images and exact file versions through purge, rollback, retry, and replacement', async t => {
  const f = await fixture(t);
  const original = await createSource(f, '첨부가 있는 양식', project);
  const logo = await addFile(f, original, '팀 로고.png', png);
  const first = await addFile(f, original, '절차 1.txt', Buffer.from('첫 번째 버전'));
  const pinnedBytes = Buffer.from('양식에서 링크한 두 번째 버전\n');
  const pinned = await appendFile(f, first, '절차 2.txt', pinnedBytes);
  const latest = await appendFile(f, pinned, '절차 3.txt', Buffer.from('현재 버전'));
  const imagePath = `/api${contentPath(logo.id)}?inline=1`;
  const pinnedPath = `/attachment-versions/${pinned.currentVersionId}/download`;
  const sameOriginLink = `${f.origin}/api${pinnedPath}`;
  const externalLink = `https://teamspace.invalid${imagePath}`;
  const source = await saveBlocks(f, original, [
    { type: 'image', attrs: { src: imagePath, alt: '팀 로고' } },
    fileLink(sameOriginLink, '작업 절차'), fileLink(`/api${pinnedPath}`, '작업 절차 다시 열기'),
    fileLink(externalLink, '외부 로고'),
  ]);
  const capture = captureRequest(source, '첨부가 있는 팀 템플릿');
  const template = await f.call<DocumentTemplateSummary>(resource, 201, 'POST', capture);
  assert.equal(template.attachmentCount, 2);
  assert.deepEqual(await f.call(resource, 200, 'POST', capture), template);

  const removed = await f.call<{ trashItemId: string }>(`/attachments/${logo.id}?expectedVersionId=${logo.currentVersionId}`, 200, 'DELETE');
  await f.call(`/trash/items/${removed.trashItemId}`, 200, 'DELETE');
  assert.equal((await f.request(contentPath(logo.id))).status, 404);
  await purgeDocument(f, source);
  assert.equal((await f.request(pinnedPath)).status, 404);

  const request = draftRequest(template);
  const workspace = await f.call<WorkspaceSnapshot>('/workspace');
  const uploads = () => readdirSync(join(f.dataDir, 'uploads')).sort();
  const beforeFiles = uploads();
  const beforeBackup = await f.call<Backup>('/export');
  const db = new DatabaseSync(join(f.dataDir, 'teamspace.sqlite'));
  try {
    db.exec(`CREATE TRIGGER fail_asset_template_receipt BEFORE INSERT ON document_creation_requests
      BEGIN SELECT RAISE(ABORT, 'synthetic template attachment receipt failure'); END`);
    await f.call('/documents', 500, 'POST', request, teammate);
    const current = await f.call<Backup>('/export');
    assert.deepEqual(current.documents, workspace.documents);
    assert.deepEqual(current.activities, workspace.activities);
    assert.deepEqual(current.attachments, beforeBackup.attachments);
    assert.deepEqual(current.revisions, beforeBackup.revisions);
    assert.deepEqual(uploads(), beforeFiles);
    assert.ok(!readdirSync(f.dataDir).some(name => name.startsWith('.append-')));
  } finally {
    db.exec('DROP TRIGGER fail_asset_template_receipt');
    db.close();
  }

  const draft = await f.call<DocPage>('/documents', 201, 'POST', request, teammate);
  assert.equal(draft.status, 'draft');
  const copies = await f.call<AttachmentHead[]>(documentFiles(draft));
  assert.deepEqual(copies.map(file => file.filename).sort(), ['절차 2.txt', '팀 로고.png']);
  for (const copy of copies) {
    assert.equal(copy.resourceType, 'document');
    assert.equal(copy.resourceId, draft.id);
    assert.equal(copy.authorId, teammate);
    assert.equal(copy.currentVersionId, copy.id);
    assert.equal(copy.versionCount, 1);
    assert.ok(![logo.id, first.id, pinned.currentVersionId, latest.currentVersionId].includes(copy.id));
  }
  const copiedLogo = copies.find(file => file.filename === logo.filename)!;
  const copiedFile = copies.find(file => file.filename === pinned.filename)!;
  assert.equal(copiedLogo.mimeType, 'image/png');
  assert.equal(copiedLogo.sha256, logo.sha256);
  assert.equal(copiedFile.sha256, pinned.sha256);
  assert.equal(draft.content.content?.[0].attrs?.src, `/api${contentPath(copiedLogo.id)}?inline=1`);
  const draftLinks = draft.content.content?.slice(1).map(node => node.content?.[0].marks?.[0].attrs?.href);
  assert.deepEqual(draftLinks, [`/api${contentPath(copiedFile.id)}`, `/api${contentPath(copiedFile.id)}`, externalLink]);
  await expectBytes(f, `${contentPath(copiedLogo.id)}?inline=1`, png);
  await expectBytes(f, contentPath(copiedFile.id), pinnedBytes);
  const afterFiles = uploads();
  assert.deepEqual(await f.call('/documents', 200, 'POST', request, teammate), draft);
  assert.deepEqual(await f.call(documentFiles(draft)), copies);
  assert.deepEqual(uploads(), afterFiles);
  const secondDraft = await f.call<DocPage>('/documents', 201, 'POST', draftRequest(template));
  const secondCopies = await f.call<AttachmentHead[]>(documentFiles(secondDraft));
  assert.deepEqual(secondCopies.map(file => file.filename).sort(), copies.map(file => file.filename).sort());
  assert.ok(secondCopies.every(file => file.resourceId === secondDraft.id && !copies.some(copy => copy.id === file.id)));
  await purgeDocument(f, secondDraft);

  const nextDocument = await createSource(f, '개정 첨부가 있는 양식', project);
  const nextBytes = Buffer.from('개정 양식에서만 쓰는 자료');
  const nextFile = await addFile(f, nextDocument, '개정.txt', nextBytes);
  const nextSource = await saveBlocks(f, nextDocument, [fileLink(`/api${contentPath(nextFile.id)}`, '개정 자료')]);
  const crossDocument = await createSource(f, '다른 문서의 파일을 가리키는 양식', project, {
    type: 'doc', content: [fileLink(`/api${contentPath(nextFile.id)}`, '다른 문서의 자료')],
  });
  const denied = await f.call<Failure>(resource, 422, 'POST', captureRequest(crossDocument, '다른 문서의 첨부가 포함된 양식'));
  assert.match(denied.error, /첨부/);
  const replaced = await f.call<DocumentTemplateSummary>(`${resource}/${template.id}`, 200, 'PATCH', {
    expectedVersion: template.version, sourceDocumentId: nextSource.id, expectedDocumentVersion: nextSource.version,
  });
  assert.equal(replaced.attachmentCount, 1);
  await purgeDocument(f, nextSource);
  const newer = await f.call<DocPage>('/documents', 201, 'POST', draftRequest(replaced));
  const newFiles = await f.call<AttachmentHead[]>(documentFiles(newer));
  assert.deepEqual(newFiles.map(file => file.filename), ['개정.txt']);
  await expectBytes(f, contentPath(newFiles[0].id), nextBytes);
  assert.deepEqual(await f.call('/documents', 200, 'POST', request, teammate), draft);
  assert.deepEqual(await f.call(documentFiles(draft)), copies);
  await expectBytes(f, `${contentPath(copiedLogo.id)}?inline=1`, png);
  await expectBytes(f, contentPath(copiedFile.id), pinnedBytes);
});

test('native backup restores template snapshots after source purge and rejects invalid captured content atomically', async t => {
  const f = await fixture(t);
  const copy = await fixture(t);
  const source = await createSource(f, '보존할 팀 양식', null);
  const template = await f.call<DocumentTemplateSummary>(resource, 201, 'POST', captureRequest(source, '공통 체크리스트'));
  const retired = await f.call<DocumentTemplateSummary>(resource, 201, 'POST', captureRequest(source, '예전 체크리스트'));
  await f.call(`${resource}/${retired.id}`, 200, 'PATCH', { expectedVersion: retired.version, archived: true });
  const localMedia: RichContent = { type: 'doc', content: [{ type: 'image', attrs: { src: '/api/attachments/synthetic/content' } }] };
  const media = await createSource(f, '로컬 첨부를 쓰는 원본', null, localMedia);
  const unsafe = await f.call<Failure>(resource, 422, 'POST', captureRequest(media, '첨부 포함'));
  assert.match(unsafe.error, /첨부/);
  const { trashEntryId } = await f.call<{ trashEntryId: string }>(`/documents/${source.id}`, 200, 'DELETE');
  await f.call(`/trash/${trashEntryId}`, 200, 'DELETE');
  const backup = await f.call<Backup>('/export');
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.equal(backup.documentTemplates.length, 2);
  const saved = backup.documentTemplates.find(value => value.id === template.id)!;
  assert.deepEqual(saved.content, source.content);
  const oldVersion = await copy.call<Failure>('/import', 400, 'POST', { data: { ...backup, schemaVersion: 62 } });
  assert.match(oldVersion.error, /schemaVersion 63/);
  await copy.call('/import', 200, 'POST', { data: { ...backup, schemaVersion: 64, documentTemplateAssets: undefined } });
  const restored = (await copy.call<DocumentTemplateSummary[]>(resource))[0];
  assert.equal(restored.id, template.id);
  assert.equal(restored.sourceDocumentId, source.id);
  assert.ok((await copy.call<DocumentTemplateSummary[]>(`${resource}?includeArchived=1`))
    .some(value => value.id === retired.id && value.archived));
  const draft = await copy.call<DocPage>('/documents', 201, 'POST', draftRequest(restored, project));
  assert.equal(draft.plainText, source.plainText);

  for (const documentTemplates of [
    [{ ...saved, content: localMedia }], [{ ...saved, updatedBy: 'missing-user' }], [saved, { ...saved, id: randomUUID() }],
  ]) {
    await copy.call('/import', 400, 'POST', { data: { ...backup, documentTemplates } });
    assert.deepEqual(await copy.call(resource), [restored]);
    assert.ok((await copy.call<WorkspaceSnapshot>('/workspace')).documents.some(value => value.id === draft.id));
  }
  await copy.call('/import', 200, 'POST', { data: backup });
  assert.ok((await copy.call<DocumentTemplateSummary[]>(resource))[0].version > restored.version);
  await copy.call('/documents', 409, 'POST', draftRequest(restored, project));
  await copy.call('/import', 200, 'POST', { data: { ...backup, schemaVersion: 62, documentTemplates: undefined, documentTemplateAssets: undefined } });
  assert.deepEqual(await copy.call(resource), []);
});

test('native backup restores exact template attachment bytes and rejects missing or altered assets atomically', async t => {
  const f = await fixture(t);
  const copy = await fixture(t);
  const original = await createSource(f, '백업할 첨부 양식', null);
  const file = await addFile(f, original, '백업.png', png);
  const source = await saveBlocks(f, original, [{ type: 'image', attrs: { src: `/api${contentPath(file.id)}?inline=1`, alt: '백업' } }]);
  const template = await f.call<DocumentTemplateSummary>(resource, 201, 'POST', captureRequest(source, '백업할 팀 템플릿'));
  const unrelated = await createSource(f, '다른 원본', null);
  const otherTemplate = await f.call<DocumentTemplateSummary>(resource, 201, 'POST', captureRequest(unrelated, '다른 팀 템플릿'));
  await purgeDocument(f, source);
  const backup = await f.call<Backup>('/export');
  assert.ok(backup.schemaVersion >= 65);
  assert.equal(backup.documentTemplateAssets.length, 1);
  assert.ok(!backup.attachments.some(attachment => attachment.id === file.id));
  const [asset] = backup.documentTemplateAssets;
  assert.equal(asset.templateId, template.id);
  assert.equal(asset.filename, file.filename);
  assert.equal(asset.mimeType, 'image/png');
  assert.equal(asset.size, png.length);
  assert.equal(asset.sha256, createHash('sha256').update(png).digest('hex'));
  assert.equal(asset.data, png.toString('base64'));
  const snapshot = backup.documentTemplates.find(value => value.id === template.id)!;
  assert.equal(snapshot.content.content?.[0].attrs?.src, `/api/document-template-assets/${asset.id}?inline=1`);

  await copy.call('/import', 200, 'POST', { data: backup });
  const restoredCatalog = await copy.call<DocumentTemplateSummary[]>(resource);
  const restored = restoredCatalog.find(value => value.id === template.id)!;
  assert.equal(restored.attachmentCount, 1);
  const draft = await copy.call<DocPage>('/documents', 201, 'POST', draftRequest(restored, project));
  const [attachment] = await copy.call<AttachmentHead[]>(documentFiles(draft));
  assert.equal(draft.content.content?.[0].attrs?.src, `/api${contentPath(attachment.id)}?inline=1`);
  await expectBytes(copy, `${contentPath(attachment.id)}?inline=1`, png);

  const changed = Buffer.from(png);
  changed[changed.length - 1] ^= 1;
  for (const documentTemplateAssets of [
    [], [{ ...asset, templateId: otherTemplate.id }], [{ ...asset, sha256: '0'.repeat(64) }],
    [{ ...asset, mimeType: 'application/octet-stream' }], [{ ...asset, data: changed.toString('base64') }],
  ]) {
    await copy.call('/import', 400, 'POST', { data: { ...backup, documentTemplateAssets } });
    assert.deepEqual(await copy.call(resource), restoredCatalog);
    assert.ok((await copy.call<WorkspaceSnapshot>('/workspace')).documents.some(document => document.id === draft.id));
  }
  const inaccurateCount = backup.documentTemplates.map(value => value.id === template.id ? { ...value, attachmentCount: 2 } : value);
  await copy.call('/import', 400, 'POST', { data: { ...backup, documentTemplates: inaccurateCount } });
  assert.deepEqual(await copy.call(resource), restoredCatalog);
  await copy.call('/import', 400, 'POST', { data: { ...backup, schemaVersion: 64 } });
  await expectBytes(copy, `${contentPath(attachment.id)}?inline=1`, png);
  await copy.call('/import', 200, 'POST', { data: backup });
  const refreshed = (await copy.call<DocumentTemplateSummary[]>(resource)).find(value => value.id === template.id)!;
  const restoredDraft = await copy.call<DocPage>('/documents', 201, 'POST', draftRequest(refreshed, project));
  const [restoredAttachment] = await copy.call<AttachmentHead[]>(documentFiles(restoredDraft));
  await expectBytes(copy, `${contentPath(restoredAttachment.id)}?inline=1`, png);
});
