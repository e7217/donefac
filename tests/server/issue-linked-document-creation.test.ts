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
import type { IssueProjectMoveInput, IssueProjectMovePreview, IssueProjectMoveResult } from '../../shared/issue-project-move.js';
import {
  documentNotificationSpaceId, type AttachmentHead, type DocPage, type DocRevision, type DocumentTemplateSummary,
  type DocumentTreeMovePreview, type Issue, type LinkedDocumentCreationResult, type Project, type ResourceLink,
  type RichContent, type TeamNotificationPage, type WorkspaceSnapshot,
} from '../../shared/types.js';

const actorId = 'user-seo';
const readerId = 'user-min';
const projectId = 'project-neo';
const issuePath = (issueId: string) => `/issues/${issueId}`;
const createPath = (issueId: string) => `${issuePath(issueId)}/documents`;
const documentPath = (documentId: string) => `/documents/${documentId}`;
const filesPath = (documentId: string) => `/attachments?${new URLSearchParams({ resourceType: 'document', resourceId: documentId })}`;
type Failure = { details: { reason: string; projectId?: string; currentVersion?: number } };

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-linked-document-'));
  async function start() {
    const runtime = createApp({ dataDir, outboundWorker: false, deadlineReminderWorker: false, recurringIssueWorker: false });
    const server = runtime.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return { runtime, server, base: `http://127.0.0.1:${address.port}/api` };
  }
  let service = await start();
  async function stop() {
    const { runtime, server } = service;
    try {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    } finally { runtime.close(); }
  }
  t.after(async () => {
    try { await stop(); }
    finally { rmSync(dataDir, { recursive: true, force: true }); }
  });
  function request(path: string, options: RequestInit = {}, actor = actorId) {
    const headers = new Headers(options.headers);
    headers.set('X-Actor-Id', actor);
    return fetch(service.base + path, { ...options, headers });
  }
  async function json<T = unknown>(path: string, method = 'GET', body?: unknown, actor = actorId) {
    const response = await request(path, {
      method, headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, actor);
    return { status: response.status, data: await response.json() as T };
  }
  async function call<T = unknown>(path: string, method = 'GET', body?: unknown, status = 200, actor = actorId) {
    const result = await json<T>(path, method, body, actor);
    assert.equal(result.status, status, `${method} ${path}: ${JSON.stringify(result.data)}`);
    return result.data;
  }
  return { call, json, request, dataDir, async restart() { await stop(); service = await start(); } };
}

function paragraph(text: string): RichContent {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

function draftFor(issue: Issue, title: string, destination: string | null = issue.projectId, parentId: string | null = null) {
  return { requestId: randomUUID(), expectedIssueProjectId: issue.projectId, projectId: destination, parentId, title };
}

test('linked document creation returns one connected draft, revision, activity and notification across concurrent retries and restart', async t => {
  const { call, json, restart } = await fixture(t);
  const issue = await call<Issue>('/issues', 'POST', { projectId, title: '연결 문서 생성의 기준 업무' }, 201);
  const other = await call<Issue>('/issues', 'POST', { projectId, title: '다른 기준 업무' }, 201);
  const parent = await call<DocPage>('/documents', 'POST', { projectId: null, title: '상위 공통 문서' }, 201);
  await call(`/notifications/subscriptions/space/${documentNotificationSpaceId(null)}`, 'PUT', { subscribed: true }, 200, readerId);
  const input = { ...draftFor(issue, '검증 결과의 연결 문서', null, parent.id), content: paragraph('합성 검증 결과'), icon: '🧪' };
  const path = createPath(issue.id);
  await call(path, 'POST', { ...input, requestId: undefined }, 400);
  await call(path, 'POST', { ...input, expectedIssueProjectId: undefined }, 400);
  await call(path, 'POST', { ...input, projectId: issue.projectId }, 400);
  await call(path, 'POST', { ...input, status: 'published' }, 400);
  const results = await Promise.all([
    json<LinkedDocumentCreationResult>(path, 'POST', input),
    json<LinkedDocumentCreationResult>(path, 'POST', { ...input, requestId: input.requestId.toUpperCase() }),
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 201]);
  const [{ data: created }, { data: replay }] = results;
  assert.deepEqual(replay, created);
  const { document, link } = created;
  assert.equal(document.title, input.title);
  assert.equal(document.status, 'draft');
  assert.equal(document.projectId, null);
  assert.equal(document.parentId, parent.id);
  assert.equal(document.authorId, actorId);
  assert.equal(document.version, 1);
  assert.equal(document.icon, input.icon);
  assert.deepEqual(document.content, input.content);
  assert.deepEqual(link, { id: link.id, issueId: issue.id, documentId: document.id, kind: '관련 문서' });
  const revisions = await call<DocRevision[]>(`${documentPath(document.id)}/revisions`);
  assert.equal(revisions.length, 1);
  assert.deepEqual(revisions[0].content, document.content);
  assert.equal(revisions[0].version, document.version);
  const saved = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(saved.documents.filter(page => page.title === input.title), [document]);
  assert.deepEqual(saved.resourceLinks.filter(value => value.issueId === issue.id || value.documentId === document.id), [link]);
  assert.deepEqual(saved.activities.filter(row => row.resourceType === 'document' && row.resourceId === document.id).map(row => [row.actorId, row.action]),
    [[actorId, '문서 생성']]);
  assert.equal(saved.activities.filter(row => row.resourceType === 'issue' && row.resourceId === issue.id && row.action === '문서 연결').length, 1);
  const inbox = await call<TeamNotificationPage>('/notifications', 'GET', undefined, 200, readerId);
  assert.equal(inbox.items.filter(event => event.kind === 'document-created' && event.targetId === document.id && event.actorId === actorId).length, 1);

  const conflict = async (target: string, value: typeof input, actor = actorId) =>
    assert.equal((await call<Failure>(target, 'POST', value, 409, actor)).details.reason, 'request_conflict');
  await conflict(path, { ...input, title: '같은 요청의 다른 제목' });
  await conflict(createPath(other.id), input);
  await conflict(path, input, readerId);
  assert.equal((await call<Failure>('/documents', 'POST', { requestId: input.requestId, title: input.title }, 409)).details.reason, 'request_conflict');
  const ordinary = await call<DocPage>('/documents', 'POST', { projectId, title: '기존 일반 문서 계약' }, 201);
  assert.equal(ordinary.title, '기존 일반 문서 계약');
  assert.ok(!Object.hasOwn(ordinary, 'document'));
  await restart();
  assert.deepEqual(await call(path, 'POST', input), created);

  const backup = await call<WorkspaceSnapshot>('/export');
  assert.ok(!JSON.stringify(backup).includes(input.requestId));
  await call('/import', 'POST', { data: backup });
  const restored = await call<WorkspaceSnapshot>('/workspace');
  const restoredDocument = restored.documents.find(page => page.id === document.id);
  assert.ok(restoredDocument);
  assert.equal(restoredDocument.parentId, parent.id);
  assert.deepEqual(restoredDocument.content, input.content);
  assert.deepEqual(restored.resourceLinks.filter(value => value.documentId === document.id), [link]);
  assert.deepEqual((await call<DocRevision[]>(`${documentPath(document.id)}/revisions`))[0].content, input.content);
  assert.equal((await call<Failure>(path, 'POST', input, 409)).details.reason, 'result_unavailable');
  assert.deepEqual((await call<WorkspaceSnapshot>('/workspace')).resourceLinks.filter(value => value.documentId === document.id), [link]);
});

test('linked document retry tracks the original relation through issue and document lifecycle without recreating removed links', async t => {
  const { call } = await fixture(t);
  const source = await call<Project>('/projects', 'POST', { key: 'LDS', name: '연결 문서 출발 공간' }, 201);
  const target = await call<Project>('/projects', 'POST', { key: 'LDD', name: '연결 문서 도착 공간' }, 201);
  const issue = await call<Issue>('/issues', 'POST', { projectId: source.id, title: '소속을 바꿀 업무' }, 201);
  const path = createPath(issue.id);
  const input = draftFor(issue, '업무 이동 뒤에도 남는 문서');
  const created = await call<LinkedDocumentCreationResult>(path, 'POST', input, 201);
  const issueEdited = await call<Issue>(issuePath(issue.id), 'PATCH', { expectedVersion: issue.version, description: '다른 작업자의 별도 편집' }, 200, readerId);
  assert.deepEqual(await call(path, 'POST', input), created);
  const move: IssueProjectMoveInput = { expectedVersion: issueEdited.version, projectId: target.id, includeConnected: false, mappings: [] };
  const preview = await call<IssueProjectMovePreview>(`${issuePath(issue.id)}/project-move/preview`, 'POST', move);
  assert.ok(preview.token, JSON.stringify(preview.blockers));
  const moved = await call<IssueProjectMoveResult>(`${issuePath(issue.id)}/project-move/apply`, 'POST', { ...move, token: preview.token });
  assert.equal(moved.issues[0].projectId, target.id);
  assert.deepEqual(await call(path, 'POST', input), created);
  const stale = await call<Failure>(path, 'POST', draftFor(issue, '예전 소속에서 만든 새 문서'), 409);
  assert.equal(stale.details.reason, 'issue_project_changed');
  assert.equal(stale.details.projectId, target.id);

  const archive = await call<{ trashEntryId: string }>(issuePath(issue.id), 'DELETE', { expectedVersion: moved.issues[0].version });
  const verifyUnavailable = async () => assert.equal((await call<Failure>(path, 'POST', input, 409)).details.reason, 'result_unavailable');
  await call(path, 'POST', draftFor(moved.issues[0], '삭제된 업무의 새 문서'), 404);
  await verifyUnavailable();
  await call(`/trash/${archive.trashEntryId}/restore`, 'POST', {});
  assert.deepEqual((await call<LinkedDocumentCreationResult>(path, 'POST', input)).link, created.link);
  const documentArchive = await call<{ trashEntryId: string }>(documentPath(created.document.id), 'DELETE', { expectedVersion: created.document.version });
  await verifyUnavailable();
  await call(`/trash/${documentArchive.trashEntryId}/restore`, 'POST', {});
  assert.deepEqual((await call<LinkedDocumentCreationResult>(path, 'POST', input)).link, created.link);

  const detachingInput = draftFor(moved.issues[0], '연결 해제를 검증할 문서');
  const disconnected = await call<LinkedDocumentCreationResult>(path, 'POST', detachingInput, 201);
  await call(`/resource-links/${disconnected.link.id}`, 'DELETE');
  const verifyDetached = async () => assert.equal((await call<Failure>(path, 'POST', detachingInput, 409)).details.reason, 'result_unavailable');
  await verifyDetached();
  const replacement = await call<ResourceLink>('/resource-links', 'POST', { issueId: issue.id, documentId: disconnected.document.id }, 201);
  assert.notEqual(replacement.id, disconnected.link.id);
  await verifyDetached();

  const moveDocumentPath = documentPath(created.document.id);
  const moveDocument = { projectId: target.id, parentId: null };
  const documentPreview = await call<DocumentTreeMovePreview>(`${moveDocumentPath}/move-preview`, 'POST', moveDocument);
  await call(`${moveDocumentPath}/move`, 'POST', { ...moveDocument, token: documentPreview.token });
  await verifyUnavailable();
  const workspace = await call<WorkspaceSnapshot>('/workspace');
  assert.equal(workspace.documents.find(page => page.id === created.document.id)?.projectId, target.id);
  assert.deepEqual(workspace.resourceLinks.filter(value => value.issueId === issue.id).sort((a, b) => a.id.localeCompare(b.id)),
    [created.link, replacement].sort((a, b) => a.id.localeCompare(b.id)));
  assert.equal(workspace.documents.filter(page => page.title === input.title).length, 1);
  assert.equal(workspace.documents.filter(page => page.title === detachingInput.title).length, 1);
});

test('linked team template rolls back installed files and all rows when the link or receipt write fails', async t => {
  const { call, request, dataDir } = await fixture(t);
  const issue = await call<Issue>('/issues', 'POST', { projectId, title: '첨부 템플릿 검증 업무' }, 201);
  const source = await call<DocPage>('/documents', 'POST', { projectId, title: '첨부가 있는 팀 양식' }, 201);
  const bytes = Buffer.from('연결 문서의 합성 절차\n');
  const uploaded = await request(`${filesPath(source.id)}&${new URLSearchParams({ filename: '절차.txt' })}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(bytes),
  });
  assert.equal(uploaded.status, 201);
  const asset = await uploaded.json() as AttachmentHead;
  const capture = await call<DocPage>(documentPath(source.id), 'PATCH', {
    expectedVersion: source.version, contentSchemaVersion: DOCUMENT_CONTENT_SCHEMA_VERSION,
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '절차 열기',
      marks: [{ type: 'link', attrs: { href: `/api/attachments/${asset.id}/content` } }] }] }] },
  });
  const template = await call<DocumentTemplateSummary>('/document-templates', 'POST', {
    requestId: randomUUID(), sourceDocumentId: capture.id, expectedDocumentVersion: capture.version, name: '검증 기록 양식',
  }, 201);
  assert.equal(template.attachmentCount, 1);
  await call(`/notifications/subscriptions/space/${documentNotificationSpaceId(projectId)}`, 'PUT', { subscribed: true }, 200, readerId);
  const input = { ...draftFor(issue, '첨부 템플릿 연결 초안'), templateId: template.id, expectedTemplateVersion: template.version };
  const path = createPath(issue.id);
  const db = new DatabaseSync(join(dataDir, 'teamspace.sqlite'));
  try {
    const tables = ['documents', 'revisions', 'attachments', 'activities', 'resource_links', 'team_notifications', 'document_creation_requests'];
    const counts = () => tables.map(table => Number(db.prepare(`SELECT count(*) AS total FROM ${table}`).get()?.total));
    const files = () => readdirSync(join(dataDir, 'uploads')).sort();
    const before = counts();
    const beforeFiles = files();
    const stale = await call<Failure>(path, 'POST', { ...input, expectedTemplateVersion: template.version + 1 }, 409);
    assert.equal(stale.details.reason, 'template_version_conflict');
    assert.equal(stale.details.currentVersion, template.version);
    assert.deepEqual(counts(), before);
    for (const table of ['resource_links', 'document_creation_requests']) {
      db.exec(`CREATE TRIGGER reject_linked_template_write BEFORE INSERT ON ${table}
        BEGIN SELECT RAISE(ABORT, 'synthetic linked template failure'); END`);
      try {
        await call(path, 'POST', input, 500);
        assert.deepEqual(counts(), before);
        assert.deepEqual(files(), beforeFiles);
        assert.ok(!readdirSync(dataDir).some(name => name.startsWith('.append-')));
      } finally { db.exec('DROP TRIGGER reject_linked_template_write'); }
    }
    const created = await call<LinkedDocumentCreationResult>(path, 'POST', input, 201);
    assert.deepEqual(await call(path, 'POST', input), created);
    assert.equal(created.document.status, 'draft');
    assert.equal(created.link.documentId, created.document.id);
    assert.equal(created.link.issueId, issue.id);
    assert.deepEqual(counts(), before.map((count, index) => count + (tables[index] === 'activities' ? 3 : 1)));
    const [copied] = await call<AttachmentHead[]>(filesPath(created.document.id));
    assert.ok(copied);
    assert.notEqual(copied.id, asset.id);
    assert.equal(copied.sha256, asset.sha256);
    const href = `/api/attachments/${copied.id}/content`;
    assert.equal(created.document.content.content?.[0].content?.[0].marks?.[0].attrs?.href, href);
    const downloaded = await request(href.slice('/api'.length));
    assert.equal(downloaded.status, 200);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  } finally { db.close(); }
});
