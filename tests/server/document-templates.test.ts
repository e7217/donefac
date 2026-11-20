import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { DOCUMENT_CONTENT_SCHEMA_VERSION } from '../../shared/document-nodes.js';
import { documentSectionHash } from '../../shared/document-sections.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type { DocPage, DocRevision, DocumentTemplate, DocumentTemplateSummary, RichContent, WorkspaceSnapshot } from '../../shared/types.js';

const editor = 'user-min';
const teammate = 'user-seo';
const project = 'project-neo';
const otherProject = 'project-team';
const resource = '/document-templates';
type Backup = WorkspaceSnapshot & { schemaVersion: number; documentTemplates: DocumentTemplate[]; revisions: DocRevision[] };
type Failure = { error: string; details: { reason: string; currentVersion?: number } };

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-document-templates-'));
  const runtime = createApp({ dataDir, outboundWorker: false });
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}/api`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  async function call<T = unknown>(path: string, status = 200, method = 'GET', data?: unknown, actorId = editor) {
    const response = await fetch(origin + path, {
      method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actorId },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const value = await response.json() as T;
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  }
  return { call, dataDir };
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
  await copy.call('/import', 200, 'POST', { data: backup });
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
  await copy.call('/import', 200, 'POST', { data: { ...backup, schemaVersion: 62, documentTemplates: undefined } });
  assert.deepEqual(await copy.call(resource), []);
});
