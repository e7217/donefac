import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../../server/app.js';
import type { ApiKeyCreated, DocPage, Issue, ResourceLink, WorkspaceSnapshot } from '../../shared/types.js';

const projectId = 'project-neo';
const commonTarget = 'project-team';
const actorId = 'user-seo';
const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '합성 결정 원문' }] }] };
type Created = { issue: Issue; link: ResourceLink; duplicate: boolean };
type FollowUpInput = { requestId: string; expectedDocumentVersion: number; issue: { projectId: string; title: string; assigneeId?: string } };
const pathFor = (documentId: string) => `/documents/${documentId}/follow-up-issues`;

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teamspace-document-follow-up-'));
  const runtime = createApp({ dataDir: directory, outboundWorker: false });
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  t.after(async () => {
    try {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } finally {
      runtime.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  async function call<T = unknown>(path: string, method = 'GET', body?: unknown, status = 200, headers: Record<string, string> = {}) {
    const response = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actorId, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${text}`);
    return JSON.parse(text) as T;
  }
  return { call, directory };
}

function followUp(document: DocPage, target: string, title: string): FollowUpInput {
  return { requestId: randomUUID(), expectedDocumentVersion: document.version, issue: { projectId: target, title } };
}

test('project documents enforce their project and common documents link to the explicit target without changing the document', async t => {
  const { call } = await fixture(t);
  const projectDocument = await call<DocPage>('/documents', 'POST', { projectId, title: '프로젝트 합성 결정', content }, 201);
  const commonDocument = await call<DocPage>('/documents', 'POST', { projectId: null, title: '공통 합성 결정', content }, 201);
  const projected = followUp(projectDocument, projectId, '프로젝트 문서의 합성 업무');
  projected.issue.assigneeId = 'user-jun';

  await call(pathFor('missing-document'), 'POST', projected, 404);
  await call(pathFor(projectDocument.id), 'POST', { ...projected, issue: { ...projected.issue, projectId: commonTarget } }, 400);
  await call(pathFor(commonDocument.id), 'POST', { ...projected, issue: { title: '프로젝트를 지정하지 않은 공통 문서 업무' } }, 400);
  const key = await call<ApiKeyCreated>('/api-keys', 'POST', { name: '회귀 검사용 키', access: 'write', projectIds: [projectId] }, 201);
  await call(`/v1${pathFor(projectDocument.id)}`, 'POST', projected, 403, { Authorization: `Bearer ${key.token}` });

  const created = await call<Created>(pathFor(projectDocument.id), 'POST', projected, 201);
  assert.equal(created.duplicate, false);
  assert.equal(created.issue.projectId, projectId);
  assert.equal(created.issue.title, projected.issue.title);
  assert.equal(created.issue.assigneeId, projected.issue.assigneeId);
  assert.deepEqual(created.link, { id: created.link.id, issueId: created.issue.id, documentId: projectDocument.id, kind: '후속 업무' });
  const common = followUp(commonDocument, commonTarget, '공통 문서의 합성 업무');
  const commonCreated = await call<Created>(pathFor(commonDocument.id), 'POST', common, 201);
  assert.equal(commonCreated.issue.projectId, commonTarget);
  assert.equal(commonCreated.link.documentId, commonDocument.id);
  assert.equal(commonCreated.link.issueId, commonCreated.issue.id);

  const workspace = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(workspace.documents.find(document => document.id === projectDocument.id), projectDocument);
  assert.deepEqual(workspace.documents.find(document => document.id === commonDocument.id), commonDocument);
  assert.deepEqual(workspace.resourceLinks.filter(link => link.documentId === projectDocument.id), [created.link]);
  assert.deepEqual(workspace.resourceLinks.filter(link => link.documentId === commonDocument.id), [commonCreated.link]);
  assert.ok(workspace.activities.some(activity => activity.resourceType === 'document' && activity.resourceId === projectDocument.id && activity.action === '후속 업무 생성' && activity.actorId === actorId));
  const ordinary = await call<Issue>('/issues', 'POST', { projectId, title: '기존 업무 생성 계약' }, 201);
  assert.equal(ordinary.title, '기존 업무 생성 계약');
  assert.equal(Object.hasOwn(ordinary, 'issue'), false);
  assert.equal((await call<WorkspaceSnapshot>('/workspace')).resourceLinks.some(link => link.issueId === ordinary.id), false);
});

test('follow-up links roll back with the issue number and retry safely across document edits and native restore', async t => {
  const { call, directory } = await fixture(t);
  const document = await call<DocPage>('/documents', 'POST', { projectId, title: '합성 재시도 결정', content }, 201);
  const input = followUp(document, projectId, '한 번만 만들 합성 후속 업무');
  const before = await call<WorkspaceSnapshot>('/workspace');
  const observer = new DatabaseSync(join(directory, 'teamspace.sqlite'));
  try {
    const nextNumber = () => observer.prepare('SELECT next_number FROM issue_sequences WHERE project_id = ?').get(projectId)?.next_number;
    const number = nextNumber();
    observer.exec("CREATE TRIGGER fail_synthetic_follow_up BEFORE INSERT ON resource_links BEGIN SELECT RAISE(ABORT, 'synthetic follow-up link failure'); END");
    await call(pathFor(document.id), 'POST', input, 500);
    assert.equal(nextNumber(), number);
    const rolledBack = await call<WorkspaceSnapshot>('/workspace');
    assert.deepEqual(rolledBack.issues, before.issues);
    assert.deepEqual(rolledBack.resourceLinks, before.resourceLinks);
    assert.deepEqual(rolledBack.activities, before.activities);
  } finally {
    observer.exec('DROP TRIGGER IF EXISTS fail_synthetic_follow_up');
    observer.close();
  }

  const created = await call<Created>(pathFor(document.id), 'POST', input, 201);
  const edited = await call<DocPage>(`/documents/${document.id}`, 'PATCH', { expectedVersion: document.version, title: '다른 작업자가 변경한 합성 결정' });
  assert.ok(edited.version > document.version);
  const replay = await call<Created>(pathFor(document.id), 'POST', input, 200);
  assert.deepEqual(replay, { ...created, duplicate: true });
  await call(pathFor(document.id), 'POST', input, 409, { 'X-Actor-Id': 'user-min' });
  await call(pathFor(document.id), 'POST', { ...input, issue: { ...input.issue, title: '같은 요청의 다른 제목' } }, 409);
  await call(pathFor(document.id), 'POST', { ...input, requestId: randomUUID() }, 409);
  const saved = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(saved.issues.filter(issue => issue.title === input.issue.title), [created.issue]);
  assert.deepEqual(saved.resourceLinks.filter(link => link.documentId === document.id), [created.link]);
  assert.equal(saved.activities.filter(activity => activity.resourceType === 'issue' && activity.resourceId === created.issue.id && activity.action === '티켓 생성').length, 1);

  const beforeRestore = followUp(edited, projectId, '형식 복원 전의 같은 버전 업무');
  const beforeRestoreCreated = await call<Created>(pathFor(document.id), 'POST', beforeRestore, 201);
  const backup = await call<WorkspaceSnapshot>('/export');
  assert.deepEqual(backup.resourceLinks.find(link => link.id === created.link.id), created.link);
  await call('/import', 'POST', { data: backup });
  await call(pathFor(document.id), 'POST', beforeRestore, 409);
  const restored = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(restored.resourceLinks.filter(link => link.documentId === document.id), [created.link, beforeRestoreCreated.link]);
  assert.deepEqual(restored.issues.filter(issue => issue.title === input.issue.title).map(issue => issue.id), [created.issue.id]);
  const restoredDoc = restored.documents.find(page => page.id === document.id);
  assert.ok(restoredDoc && restoredDoc.version > edited.version);

  const forUnlink = followUp(restoredDoc, projectId, '연결 해제 후 중복 방지 업무');
  const unlinked = await call<Created>(pathFor(document.id), 'POST', forUnlink, 201);
  await call(`/resource-links/${unlinked.link.id}`, 'DELETE');
  await call(pathFor(document.id), 'POST', forUnlink, 409);
  const afterUnlink = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(afterUnlink.issues.filter(issue => issue.title === forUnlink.issue.title), [unlinked.issue]);
  assert.ok(!afterUnlink.resourceLinks.some(link => link.issueId === unlinked.issue.id));
});
