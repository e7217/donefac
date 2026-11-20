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
import type { ApiKeyCreated, DocPage, DocRevision, Issue, ResourceLink, RichContent, WorkspaceSnapshot } from '../../shared/types.js';

const projectId = 'project-neo';
const commonTarget = 'project-team';
const actorId = 'user-seo';
const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '합성 결정 원문' }] }] };
type Created = { issue: Issue; link: ResourceLink; duplicate: boolean };
type FollowUpInput = {
  requestId: string;
  expectedDocumentVersion: number;
  issue: { projectId: string; title: string; assigneeId?: string };
  sourceSelection?: { from: number; to: number; text: string };
};
type Backup = WorkspaceSnapshot & {
  schemaVersion: number;
  trashEntries: { id: string; resourceId: string; resourceLinks: ResourceLink[] }[];
};
const pathFor = (documentId: string) => `/documents/${documentId}/follow-up-issues`;

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teamspace-document-follow-up-'));
  async function start() {
    const runtime = createApp({ dataDir: directory, outboundWorker: false });
    const server = runtime.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { runtime, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api` };
  }
  let service = await start();
  async function stop() {
    const { runtime, server } = service;
    try {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } finally { runtime.close(); }
  }
  t.after(async () => {
    try { await stop(); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  });
  async function call<T = unknown>(path: string, method = 'GET', body?: unknown, status = 200, headers: Record<string, string> = {}) {
    const response = await fetch(service.base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actorId, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${text}`);
    return JSON.parse(text) as T;
  }
  async function restart() { await stop(); service = await start(); }
  return { call, directory, restart };
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

test('the selected decision is bound to its exact stored source through edits, replay and native restore', async t => {
  const { call, restart } = await fixture(t);
  const prefix = '회의에서 ';
  const marked = '재현 조건';
  const ending = '을 고정하기로 했다.';
  const next = '변경 전에 실측한다.';
  const body: RichContent = { type: 'doc', content: [
    { type: 'paragraph', content: [
      { type: 'text', text: prefix },
      { type: 'text', text: marked, marks: [{ type: 'bold' }] },
      { type: 'text', text: ending },
    ] },
    { type: 'paragraph', content: [{ type: 'text', text: `${next} 담당자는 회의록에 기록한다.` }] },
  ] };
  const doc = await call<DocPage>('/documents', 'POST', { projectId, title: '결정 당시 설계', content: body }, 201);
  const other = await call<DocPage>('/documents', 'POST', { projectId, title: '같은 본문이 있는 별도 문서', content: body }, 201);
  const [original] = await call<DocRevision[]>(`/documents/${doc.id}/revisions`);
  const [wrongOwner] = await call<DocRevision[]>(`/documents/${other.id}/revisions`);
  assert.equal(original.version, doc.version);
  const sourceSelection = {
    from: 1 + prefix.length,
    to: prefix.length + marked.length + ending.length + 3 + next.length,
    text: `${marked}${ending}\n${next}`,
  };
  const input = { ...followUp(doc, projectId, '원문 결정에 연결된 업무'), sourceSelection };
  const before = await call<WorkspaceSnapshot>('/workspace');
  await call(pathFor(doc.id), 'POST', { ...input, sourceSelection: { ...sourceSelection, text: '다른 선택' } }, 409);
  await call(pathFor(doc.id), 'POST', { ...input, sourceSelection: { ...sourceSelection, from: sourceSelection.to } }, 400);
  assert.deepEqual(await call<WorkspaceSnapshot>('/workspace'), before);

  const created = await call<Created>(pathFor(doc.id), 'POST', input, 201);
  const storedContext = { ...sourceSelection, revisionId: original.id };
  assert.deepEqual(created.link.documentSource, storedContext);
  assert.equal(created.issue.description, '');
  assert.equal((await call<DocRevision[]>(`/documents/${doc.id}/revisions`)).length, 1);
  const latest = await call<DocPage>(`/documents/${doc.id}`, 'PATCH', {
    expectedVersion: doc.version, title: '다시 검토한 설계', content,
  });
  await call(pathFor(doc.id), 'POST', { ...input, requestId: randomUUID() }, 409);
  await call(pathFor(doc.id), 'POST', { ...input, sourceSelection: { ...sourceSelection, from: sourceSelection.from - 1 } }, 409);
  await restart();
  assert.deepEqual(await call<Created>(pathFor(doc.id), 'POST', input), { ...created, duplicate: true });
  const revisionPath = `/documents/${doc.id}/include-revisions/${original.id}`;
  assert.deepEqual(await call<DocRevision>(revisionPath), original);

  const activeBackup = await call<Backup>('/export');
  assert.equal(activeBackup.schemaVersion, 36);
  const storedLink = activeBackup.resourceLinks.find(link => link.id === created.link.id);
  assert.ok(storedLink?.documentSource);
  assert.deepEqual(storedLink.documentSource, storedContext);
  const liveState = await call<WorkspaceSnapshot>('/workspace');
  for (const replacement of [
    { ...storedContext, revisionId: wrongOwner.id },
    { ...storedContext, text: '백업에서 바뀐 인용' },
    { ...storedContext, from: storedContext.from - 1 },
  ]) {
    const invalidBackup = structuredClone(activeBackup);
    invalidBackup.resourceLinks.find(link => link.id === storedLink.id)!.documentSource = replacement;
    await call('/import', 'POST', { data: invalidBackup }, 400);
    assert.deepEqual(await call<WorkspaceSnapshot>('/workspace'), liveState);
  }
  await call('/import', 'POST', { data: { ...activeBackup, schemaVersion: 35 } }, 400);
  await call('/import', 'POST', { data: activeBackup });
  assert.deepEqual((await call<WorkspaceSnapshot>('/workspace')).resourceLinks.find(link => link.id === storedLink.id), created.link);
  assert.deepEqual(await call<DocRevision>(revisionPath), original);

  const current = (await call<WorkspaceSnapshot>('/workspace')).documents.find(page => page.id === latest.id);
  assert.ok(current);
  const archived = await call<{ trashEntryId: string }>(`/documents/${doc.id}`, 'DELETE', { expectedVersion: current.version });
  const archivedBackup = await call<Backup>('/export');
  const archivedSource = archivedBackup.trashEntries.find(entry => entry.id === archived.trashEntryId);
  assert.equal(archivedSource?.resourceId, doc.id);
  assert.deepEqual(archivedSource?.resourceLinks, [created.link]);
  const invalidArchive = structuredClone(archivedBackup);
  invalidArchive.trashEntries.find(entry => entry.id === archived.trashEntryId)!.resourceLinks[0].documentSource = {
    ...storedContext, revisionId: wrongOwner.id,
  };
  await call('/import', 'POST', { data: invalidArchive }, 400);
  await call('/import', 'POST', { data: archivedBackup });
  assert.deepEqual(await call<DocRevision>(revisionPath), original);
  await call(`/trash/${archived.trashEntryId}/restore`, 'POST', {});
  assert.deepEqual((await call<WorkspaceSnapshot>('/workspace')).resourceLinks.find(link => link.id === storedLink.id), created.link);

  const archivedIssue = await call<{ trashEntryId: string }>(`/issues/${created.issue.id}`, 'DELETE');
  const removedDocument = await call<{ trashEntryId: string }>(`/documents/${doc.id}`, 'DELETE');
  await call(`/trash/${removedDocument.trashEntryId}`, 'DELETE');
  const orphanBackup = await call<Backup>('/export');
  const orphanLink = orphanBackup.trashEntries.find(entry => entry.id === archivedIssue.trashEntryId)?.resourceLinks[0];
  assert.deepEqual(orphanLink?.documentSource, storedContext);
  await call('/import', 'POST', { data: orphanBackup });
  const restored = await call<{ warnings: string[] }>(`/trash/${archivedIssue.trashEntryId}/restore`, 'POST', {});
  assert.ok(restored.warnings.some(warning => warning.includes('업무·문서 연결')));
  assert.equal((await call<WorkspaceSnapshot>('/workspace')).resourceLinks.some(link => link.id === storedLink.id), false);
});

test('a missing source snapshot is recorded in the same transaction as its decision link', async t => {
  const { call, directory } = await fixture(t);
  const doc = await call<DocPage>('/documents', 'POST', { projectId, title: '저장본 연결 검증', content }, 201);
  const sourceSelection = { from: 1, to: doc.plainText.length + 1, text: doc.plainText };
  const input = { ...followUp(doc, projectId, '저장본과 함께 추가할 업무'), sourceSelection };
  const observer = new DatabaseSync(join(directory, 'teamspace.sqlite'));
  try {
    // A saved body without an exact history row exercises the same insertion path as pre-checkpoint collaboration.
    observer.prepare('DELETE FROM revisions WHERE document_id=?').run(doc.id);
    const before = await call<WorkspaceSnapshot>('/workspace');
    const number = () => observer.prepare('SELECT next_number FROM issue_sequences WHERE project_id=?').get(projectId)?.next_number;
    const nextNumber = number();
    observer.exec("CREATE TRIGGER fail_decision_link BEFORE INSERT ON resource_links BEGIN SELECT RAISE(ABORT, 'synthetic decision link failure'); END");
    await call(pathFor(doc.id), 'POST', input, 500);
    assert.deepEqual(await call<WorkspaceSnapshot>('/workspace'), before);
    assert.deepEqual(await call<DocRevision[]>(`/documents/${doc.id}/revisions`), []);
    assert.equal(number(), nextNumber);
  } finally {
    observer.exec('DROP TRIGGER IF EXISTS fail_decision_link');
    observer.close();
  }
  const created = await call<Created>(pathFor(doc.id), 'POST', input, 201);
  const [stored] = await call<DocRevision[]>(`/documents/${doc.id}/revisions`);
  assert.equal(stored.version, doc.version);
  assert.deepEqual(stored.content, doc.content);
  assert.deepEqual(created.link.documentSource, { ...sourceSelection, revisionId: stored.id });
  assert.deepEqual((await call<WorkspaceSnapshot>('/workspace')).documents.find(page => page.id === doc.id), doc);
});
