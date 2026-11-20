import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { createApp } from '../../server/app.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import { COLLABORATION_SCHEMA, type CollaborationServerMessage, type CollaborationSession } from '../../shared/collaboration.js';
import type {
  ApiKeyCreated, Attachment, AttachmentHead, AttachmentVersion, Comment, Dependency, DocPage, DocRevision, DocumentPublicationView,
  GitlabLink, GitlabSettings, GitlabSyncResult, Issue, IssueWorklogPage, Milestone, ProjectWorklogReport, ReportingLedgerData, ResourceLink, RichContent, TrashEntrySummary, TrashPage,
  TrashResourceType, TrashRestoreResult, WorklogEntry, WorkspaceSnapshot,
} from '../../shared/types.js';

const projectId = 'project-neo';
const actor = 'user-min';
const reviewer = 'user-seo';
const originalBytes = Buffer.from('복원할 첨부 원본\0\r\n');
const revisedBytes = Buffer.from('%PDF-1.7\n휴지통 첨부 수정본\n');
const docContent = (text: string): RichContent => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const versionPath = (id: string) => `/attachment-versions/${id}/download`;
const contentPath = (id: string) => `/attachments/${id}/content`;

type Backup = WorkspaceSnapshot & {
  schemaVersion: number;
  attachments: Attachment[];
  attachmentVersions: AttachmentVersion[];
  attachmentContents: { id: string; data: string }[];
  reportingLedger: ReportingLedgerData;
  trashEntries?: unknown[];
};
type GitlabBackup = Omit<Backup, 'trashEntries'> & { trashEntries: { id: string; gitlabLinks: GitlabLink[] }[] };
const branchInTrash = (backup: GitlabBackup, entry: TrashEntrySummary) => backup.trashEntries.find(row => row.id === entry.id)?.gitlabLinks.find(link => link.kind === 'branch');

async function open(dataDir: string) {
  const runtime = createApp({ dataDir, outboundWorker: false });
  const server = runtime.app.listen(0, '127.0.0.1');
  runtime.attachWebSocket(server);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    base: `http://127.0.0.1:${address.port}/api`,
    async close() {
      runtime.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-trash-'));
  let running: Awaited<ReturnType<typeof open>> | undefined;
  t.after(async () => {
    try { await running?.close(); }
    finally { rmSync(dataDir, { recursive: true, force: true }); }
  });
  running = await open(dataDir);
  const request = (path: string, init?: RequestInit) => fetch(running!.base + path, init);
  return {
    request, dataDir,
    get socketUrl() { return running!.base.replace(/^http:/, 'ws:') + '/collaboration'; },
    async restart() {
      await running!.close();
      running = undefined;
      running = await open(dataDir);
    },
    async call<T = unknown>(path: string, method = 'GET', input?: unknown, status = 200, actorId = actor) {
      const response = await request(path, {
        method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actorId },
        body: input === undefined ? undefined : JSON.stringify(input),
      });
      const body = await response.text();
      assert.equal(response.status, status, `${method} ${path}: ${body}`);
      return JSON.parse(body) as T;
    },
    async upload(path: string, bytes: Buffer) {
      const response = await request(path, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': reviewer },
        body: new Uint8Array(bytes),
      });
      const body = await response.text();
      assert.equal(response.status, 201, body);
      return JSON.parse(body) as AttachmentHead;
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const issuePath = (id: string) => `/issues/${id}`;
const documentPath = (id: string) => `/documents/${id}`;
const trashPath = (entry: TrashEntrySummary) => `/trash/${entry.id}`;
const trash = (f: Fixture, query = '') => f.call<TrashPage>('/trash' + query);
const workspace = (f: Fixture) => f.call<WorkspaceSnapshot>('/workspace');
const makeIssue = (f: Fixture, title: string, extra: Partial<Issue> = {}) => f.call<Issue>('/issues', 'POST', { projectId, title, ...extra }, 201);
const makeDocument = (f: Fixture, title: string, docProjectId: string | null = projectId) =>
  f.call<DocPage>('/documents', 'POST', { projectId: docProjectId, title, content: docContent(title) }, 201);

async function makeAttachment(f: Fixture, resourceType: TrashResourceType, resourceId: string) {
  const query = new URLSearchParams({ resourceType, resourceId, filename: '휴지통 원본.txt' });
  const original = await f.upload(`/attachments?${query}`, originalBytes);
  const append = new URLSearchParams({ expectedVersionId: original.id, filename: '휴지통 수정본.pdf' });
  const latest = await f.upload(`/attachments/${original.id}/versions?${append}`, revisedBytes);
  assert.equal(latest.id, original.id);
  return { original, latest };
}

async function archive(f: Fixture, resourceType: TrashResourceType, resource: Issue | DocPage, actorId = actor) {
  const path = resourceType === 'issue' ? issuePath(resource.id) : documentPath(resource.id);
  const removed = await f.call<{ ok: boolean }>(path, 'DELETE', { expectedVersion: resource.version }, 200, actorId);
  assert.equal(removed.ok, true);
  const page = await trash(f, `?resourceType=${resourceType}`);
  const entry = page.items.find(value => value.resourceId === resource.id);
  assert.ok(entry, `Could not find archived ${resourceType} ${resource.id}`);
  assert.equal(entry.deletedById, actorId);
  assert.equal(entry.projectId, resource.projectId);
  assert.equal(entry.parentId, resource.parentId);
  assert.equal(entry.resourceType, resourceType);
  assert.equal(entry.title, resource.title);
  assert.equal(entry.issueKey, 'key' in resource ? resource.key : null);
  assert.ok(Number.isFinite(Date.parse(entry.deletedAt)));
  return entry;
}

function restore(f: Fixture, entry: TrashEntrySummary, status = 200) {
  return f.call<TrashRestoreResult>(`${trashPath(entry)}/restore`, 'POST', {}, status, reviewer);
}

test('native schema 24 retains live and trashed GitLab branches and rejects malformed or older branch records', async t => {
  const f = await fixture(t);
  const live = await makeIssue(f, '현재 GitLab 브랜치');
  const archived = await makeIssue(f, '보관된 GitLab 브랜치');
  const baseUrl = 'https://git.example.test/forge';
  const projectUrl = `${baseUrl}/team/engine`;
  const webhookSecret = 'synthetic-native-branch-test';
  const settings = await f.call<GitlabSettings>('/integrations/gitlab');
  await f.call('/integrations/gitlab', 'PATCH', { expectedVersion: settings.version, baseUrl, projectIds: [42], webhookSecret });
  const push = async (issue: Issue, before: string, after: string) => {
    const response = await f.request('/integrations/gitlab/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Gitlab-Token': webhookSecret, 'X-Gitlab-Event': 'Push Hook', 'webhook-id': randomUUID() },
      body: JSON.stringify({
        object_kind: 'push', project_id: 42, ref: `refs/heads/work/${issue.key}`, before, after,
        checkout_sha: /^0+$/.test(after) ? null : after, commits: [], total_commits_count: 0,
        project: { id: 42, web_url: projectUrl, path_with_namespace: 'team/engine' },
      }),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    return JSON.parse(body) as { linked: number };
  };

  const zero = '0'.repeat(40);
  const liveHead = 'a'.repeat(40);
  const archivedHead = 'b'.repeat(40);
  const observedHead = 'c'.repeat(40);
  assert.equal((await push(live, zero, liveHead)).linked, 1);
  assert.equal((await push(archived, zero, archivedHead)).linked, 1);
  const beforeBranchDeletion = await archive(f, 'issue', archived);
  const beforeImport = await f.call<GitlabBackup>('/export');
  assert.ok(!beforeImport.gitlabLinks.some(link => link.issueId === archived.id));
  assert.equal(branchInTrash(beforeImport, beforeBranchDeletion)?.state, 'active');
  assert.equal(branchInTrash(beforeImport, beforeBranchDeletion)?.sourceSha, archivedHead);
  await f.call('/import', 'POST', { data: beforeImport });

  assert.equal((await push(archived, archivedHead, observedHead)).linked, 0);
  const checkpoint = await f.call<GitlabBackup>('/export');
  assert.equal(branchInTrash(checkpoint, beforeBranchDeletion)?.state, 'active');
  assert.equal(branchInTrash(checkpoint, beforeBranchDeletion)?.sourceSha, observedHead);
  assert.equal((await push(archived, observedHead, zero)).linked, 0);
  const checkpointAfterDeletion = await f.call<GitlabBackup>('/export');
  const deleted = branchInTrash(checkpointAfterDeletion, beforeBranchDeletion);
  assert.equal(deleted?.state, 'deleted');
  assert.equal(deleted?.sourceSha, observedHead);
  await restore(f, beforeBranchDeletion);
  const afterBranchDeletion = await workspace(f);
  const restoredIssue = afterBranchDeletion.issues.find(issue => issue.id === archived.id);
  assert.ok(restoredIssue);
  assert.deepEqual(afterBranchDeletion.gitlabLinks.find(link => link.issueId === archived.id), deleted);
  const entry = await archive(f, 'issue', restoredIssue);
  const backup = await f.call<GitlabBackup>('/export');
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  const liveLink = backup.gitlabLinks.find(link => link.issueId === live.id && link.kind === 'branch')!;
  const archiveRow = backup.trashEntries.find(row => row.id === entry.id)!;
  const archivedLink = archiveRow.gitlabLinks.find(link => link.issueId === archived.id && link.kind === 'branch')!;
  assert.equal(liveLink.state, 'active');
  assert.equal(archivedLink.state, 'deleted');
  assert.equal(archivedLink.sourceSha, observedHead);
  assert.ok(!backup.gitlabLinks.some(link => link.issueId === archived.id));

  const read = await f.call<ApiKeyCreated>('/api-keys', 'POST', { name: '개발 활동 조회 검증', access: 'read', projectIds: [projectId], expiresAt: null }, 201);
  const denied = await f.call<ApiKeyCreated>('/api-keys', 'POST', { name: '다른 프로젝트 키', access: 'read', projectIds: ['project-team'], expiresAt: null }, 201);
  const readLinks = (token: string, query = '') => f.request(`/v1/issues/${live.id}/gitlab-links${query}`, { headers: { Authorization: `Bearer ${token}` } });
  const matching = await readLinks(read.token, '?kind=branch');
  assert.equal(matching.status, 200);
  assert.deepEqual(await matching.json(), { links: [liveLink], total: 1, offset: 0, limit: 50 });
  const nextPage = await readLinks(read.token, '?kind=branch&offset=50');
  assert.equal(nextPage.status, 200);
  assert.deepEqual(await nextPage.json(), { links: [], total: 1, offset: 50, limit: 50 });
  assert.equal((await readLinks(read.token, '?kind=branch&offset=-1')).status, 400);
  assert.equal((await readLinks(denied.token)).status, 403);

  const downgradeLive = structuredClone(backup);
  downgradeLive.schemaVersion = 23;
  downgradeLive.trashEntries.find(row => row.id === entry.id)!.gitlabLinks = [];
  assert.match((await f.call<{ error: string }>('/import', 'POST', { data: downgradeLive }, 400)).error, /schemaVersion 24/);
  const downgradeArchived = structuredClone(backup);
  downgradeArchived.schemaVersion = 23;
  downgradeArchived.gitlabLinks = downgradeArchived.gitlabLinks.filter(link => link.kind !== 'branch');
  assert.match((await f.call<{ error: string }>('/import', 'POST', { data: downgradeArchived }, 400)).error, /schemaVersion 24/);
  const corruptActive = structuredClone(backup);
  corruptActive.gitlabLinks.find(link => link.id === liveLink.id)!.sourceSha = zero;
  await f.call('/import', 'POST', { data: corruptActive }, 400);
  const corruptArchived = structuredClone(backup);
  corruptArchived.trashEntries.find(row => row.id === entry.id)!.gitlabLinks[0].webUrl = `${projectUrl}/-/tree/unrelated`;
  await f.call('/import', 'POST', { data: corruptArchived }, 400);
  assert.deepEqual((await workspace(f)).gitlabLinks.find(link => link.id === liveLink.id), liveLink);
  assert.deepEqual((await trash(f)).items.find(item => item.id === entry.id), entry);

  const compatible = structuredClone(downgradeArchived);
  compatible.trashEntries.find(row => row.id === entry.id)!.gitlabLinks = [];
  await f.call('/import', 'POST', { data: compatible });
  assert.ok(!(await workspace(f)).gitlabLinks.some(link => link.kind === 'branch'));
  await f.call('/import', 'POST', { data: backup });
  await f.restart();
  assert.deepEqual((await workspace(f)).gitlabLinks.find(link => link.id === liveLink.id), liveLink);
  assert.equal((await push(live, 'f'.repeat(40), zero)).linked, 0);
  assert.deepEqual((await workspace(f)).gitlabLinks.find(link => link.id === liveLink.id), liveLink);
  await restore(f, entry);
  assert.deepEqual((await workspace(f)).gitlabLinks.find(link => link.id === archivedLink.id), archivedLink);
});

test('schema 28 preserves GitLab observations for the first authenticated deletion after restoring trash', async t => {
  const f = await fixture(t);
  const issue = await makeIssue(f, '조회로 처음 연결한 GitLab 브랜치');
  const branch = `work/${issue.key}`;
  const sampledHead = 'a'.repeat(40), removedHead = 'b'.repeat(40), zero = '0'.repeat(40);
  const mock = createServer((req, res) => {
    const path = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    res.setHeader('Content-Type', 'application/json');
    if (path === '/forge/api/v4/projects/42') res.end(JSON.stringify({ id: 42, path_with_namespace: 'team/engine' }));
    else if (path.endsWith('/repository/branches')) res.end(JSON.stringify([{ name: branch, commit: { id: sampledHead } }]));
    else res.end('[]');
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  t.after(() => new Promise<void>(resolve => {
    mock.close(() => resolve());
    mock.closeAllConnections();
  }));
  const address = mock.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}/forge`;
  const webhookSecret = 'synthetic-native-branch-history-test';
  const settings = await f.call<GitlabSettings>('/integrations/gitlab');
  await f.call('/integrations/gitlab', 'PATCH', { expectedVersion: settings.version, baseUrl, projectIds: [42], webhookSecret });
  const history = await f.call<GitlabSyncResult>('/integrations/gitlab/sync', 'POST', { includeHistory: true });
  assert.equal(history.linked, 1);
  assert.deepEqual(history.historyCounts, { branches: 1, commits: 0 });
  const live = await workspace(f);
  const sampled = live.gitlabLinks.find(link => link.issueId === issue.id);
  assert.ok(sampled);
  assert.equal(sampled.sourceSha, sampledHead);
  assert.equal(sampled.branchObservationSource, 'sync');
  const liveBackup = await f.call<GitlabBackup>('/export');
  assert.equal(liveBackup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.deepEqual(liveBackup.gitlabLinks.find(link => link.id === sampled.id), sampled);
  const unsupportedLive = await f.call<{error: string}>('/import', 'POST', { data: { ...liveBackup, schemaVersion: 27 } }, 400);
  assert.match(unsupportedLive.error, /28/);
  assert.deepEqual(await workspace(f), live);

  const entry = await archive(f, 'issue', issue);
  const backup = await f.call<GitlabBackup>('/export');
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.ok(!backup.gitlabLinks.some(link => link.id === sampled.id));
  assert.deepEqual(branchInTrash(backup, entry), sampled);
  const archived = await workspace(f);
  const unsupportedTrash = await f.call<{error: string}>('/import', 'POST', { data: { ...backup, schemaVersion: 27 } }, 400);
  assert.match(unsupportedTrash.error, /28/);
  assert.deepEqual(await workspace(f), archived);
  assert.deepEqual(branchInTrash(await f.call<GitlabBackup>('/export'), entry), sampled);
  await f.call('/import', 'POST', { data: backup });

  const response = await f.request('/integrations/gitlab/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Gitlab-Token': webhookSecret, 'X-Gitlab-Event': 'Push Hook', 'webhook-id': randomUUID() },
    body: JSON.stringify({
      object_kind: 'push', project_id: 42, ref: `refs/heads/${branch}`, before: removedHead, after: zero,
      checkout_sha: null, commits: [], total_commits_count: 0,
      project: { id: 42, path_with_namespace: 'team/engine' },
    }),
  });
  assert.equal(response.status, 200, await response.text());
  const deleted = branchInTrash(await f.call<GitlabBackup>('/export'), entry);
  assert.equal(deleted?.state, 'deleted');
  assert.equal(deleted?.sourceSha, removedHead);
  assert.equal(deleted?.id, sampled.id);
  assert.equal(deleted?.branchObservationSource, undefined);
  await restore(f, entry);
  assert.deepEqual((await workspace(f)).gitlabLinks.find(link => link.issueId === issue.id), deleted);
});

async function bytes(f: Fixture, path: string, expected: Buffer) {
  const response = await f.request(path);
  assert.equal(response.status, 200, path);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
}

function openSocket(f: Fixture, documentId: string) {
  return new WebSocket(`${f.socketUrl}?${new URLSearchParams({ documentId, actorId: reviewer })}`);
}

function message<T extends CollaborationServerMessage['type']>(socket: WebSocket, type: T) {
  return new Promise<Extract<CollaborationServerMessage, { type: T }>>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', receive);
      reject(new Error(`Waiting for collaboration message ${type} timed out`));
    }, 5000);
    function receive(raw: Buffer) {
      const parsed = JSON.parse(raw.toString()) as CollaborationServerMessage;
      if (parsed.type !== type) return;
      clearTimeout(timer);
      socket.off('message', receive);
      resolve(parsed as Extract<CollaborationServerMessage, { type: T }>);
    }
    socket.on('message', receive);
  });
}

test('issue trash hides canonical data and restores attachments, worklogs, and deferred links when their endpoints return', async t => {
  const f = await fixture(t);
  const before = await makeIssue(f, '휴지통 합성 선행 업무', { startDate: '2026-11-19', endDate: '2026-11-20' });
  const target = await makeIssue(f, '휴지통 합성 후행 업무', { startDate: '2026-11-23', endDate: '2026-11-25' });
  const document = await makeDocument(f, '휴지통 합성 연결 문서');
  const dependency = await f.call<Dependency>('/dependencies', 'POST', { predecessorId: before.id, successorId: target.id, lagDays: 1 }, 201);
  const link = await f.call<ResourceLink>('/resource-links', 'POST', { issueId: target.id, documentId: document.id, kind: '합성 복원 관계' }, 201);
  const milestone = await f.call<Milestone>('/milestones', 'POST', { projectId, title: '휴지통과 연결된 출시 시점', date: '2026-11-25', issueIds: [target.id] }, 201);
  const commentInput = { resourceType: 'issue', resourceId: target.id, body: '복원할 업무 댓글' };
  const comment = await f.call<Comment>('/comments', 'POST', commentInput, 201, reviewer);
  const listComments = `/comments?resourceType=issue&resourceId=${target.id}`;
  const worklogPath = `${issuePath(target.id)}/worklogs`;
  const worklog = await f.call<WorklogEntry>(worklogPath, 'POST', { requestId: randomUUID(), workDate: '2026-11-19', minutes: 45, note: '복원할 진행 시간' }, 201);
  const { original, latest } = await makeAttachment(f, 'issue', target.id);

  await f.call(issuePath(target.id), 'DELETE', { expectedVersion: target.version + 1 }, 409);
  assert.equal((await trash(f)).total, 0);
  const observer = new DatabaseSync(join(f.dataDir, 'teamspace.sqlite'));
  try {
    observer.exec("CREATE TRIGGER fail_trash_audit BEFORE INSERT ON activities BEGIN SELECT RAISE(ABORT,'synthetic trash rollback'); END;");
    await f.call(issuePath(target.id), 'DELETE', { expectedVersion: target.version }, 500);
  } finally {
    observer.exec('DROP TRIGGER IF EXISTS fail_trash_audit');
    observer.close();
  }
  assert.equal((await trash(f)).total, 0);
  assert.deepEqual((await workspace(f)).issues.find(issue => issue.id === target.id), target);
  assert.deepEqual(await f.call<Comment[]>(listComments), [comment]);
  await bytes(f, contentPath(latest.currentVersionId), revisedBytes);

  const entry = await archive(f, 'issue', target, reviewer);
  const beforeEntry = await archive(f, 'issue', before);
  const documentEntry = await archive(f, 'document', document);
  const hidden = await workspace(f);
  assert.ok(!hidden.issues.some(issue => [before.id, target.id].includes(issue.id)));
  assert.ok(!hidden.documents.some(doc => doc.id === document.id));
  assert.ok(!hidden.dependencies.some(value => value.id === dependency.id));
  assert.ok(!hidden.resourceLinks.some(value => value.id === link.id));
  assert.deepEqual(hidden.milestones?.find(value => value.id === milestone.id)?.issueIds, []);
  const search = await f.call<{ issues: Issue[] }>('/search?' + new URLSearchParams({ q: target.title }));
  assert.deepEqual(search.issues, []);
  await f.call(listComments, 'GET', undefined, 404);
  await f.call(contentPath(original.id), 'GET', undefined, 404);
  await f.call(versionPath(latest.currentVersionId), 'GET', undefined, 404);
  await f.call(worklogPath, 'GET', undefined, 404);
  const reportPath = `/projects/${projectId}/worklog-report?startDate=2026-11-01&endDate=2026-11-30`;
  assert.equal((await f.call<ProjectWorklogReport>(reportPath)).byIssue.find(value => value.issueId === target.id)?.deleted, true);

  const restored = await restore(f, entry);
  assert.equal(restored.resourceId, target.id);
  assert.equal(restored.resourceType, 'issue');
  assert.equal(restored.projectId, projectId);
  assert.ok(Array.isArray(restored.warnings));
  const partial = await workspace(f);
  const active = partial.issues.find(issue => issue.id === target.id)!;
  assert.equal(active.key, target.key);
  assert.ok(active.version > target.version);
  assert.equal(active.startDate, target.startDate);
  assert.equal(active.endDate, target.endDate);
  assert.ok(!partial.dependencies.some(value => value.id === dependency.id));
  assert.ok(!partial.resourceLinks.some(value => value.id === link.id));
  assert.deepEqual(partial.milestones?.find(value => value.id === milestone.id)?.issueIds, [target.id]);
  await f.call(issuePath(target.id), 'PATCH', { expectedVersion: target.version, title: '오래된 편집' }, 409);
  assert.deepEqual(await f.call<Comment[]>(listComments), [comment]);
  assert.deepEqual((await f.call<IssueWorklogPage>(worklogPath)).entries, [worklog]);
  assert.equal((await f.call<ProjectWorklogReport>(reportPath)).byIssue.find(value => value.issueId === target.id)?.deleted, false);
  const heads = `/attachments?resourceType=issue&resourceId=${target.id}`;
  assert.deepEqual(await f.call<AttachmentHead[]>(heads), [latest]);
  await bytes(f, contentPath(original.id), originalBytes);
  await bytes(f, versionPath(latest.currentVersionId), revisedBytes);

  const deferredBackup = await f.call<Backup>('/export');
  assert.equal(deferredBackup.trashEntries?.length, 2);
  await f.call('/import', 'POST', { data: deferredBackup });
  await restore(f, documentEntry);
  await restore(f, beforeEntry);
  const complete = await workspace(f);
  const restoredDependency = complete.dependencies.find(value => value.id === dependency.id);
  assert.ok(restoredDependency && (restoredDependency.version ?? 1) > (dependency.version ?? 1));
  assert.deepEqual(restoredDependency, { ...dependency, version:restoredDependency.version });
  assert.deepEqual(complete.resourceLinks.find(value => value.id === link.id), link);
  await restore(f, entry, 404);
  assert.equal((await trash(f)).total, 0);
  const exported = await f.call<Backup>('/export');
  const events = exported.reportingLedger.events.filter(event => event.issueId === target.id && event.kind !== 'baseline');
  assert.deepEqual(events.map(event => [event.kind, event.origin]), [['created', 'user'], ['deleted', 'user'], ['restored', 'restore']]);
  await f.call('/import', 'POST', { data: exported });
  const reloaded = await f.call<Backup>('/export');
  assert.deepEqual(reloaded.reportingLedger.events.filter(event => event.issueId === target.id && event.kind !== 'baseline'), events);
});

test('trash filters its scope and retains children until their parent can be restored', async t => {
  const f = await fixture(t);
  const parent = await makeIssue(f, '휴지통 합성 상위 업무');
  const child = await makeIssue(f, '휴지통 합성 하위 업무', { parentId: parent.id });
  const common = await makeDocument(f, '휴지통 합성 공통 문서', null);
  await f.call(issuePath(parent.id), 'DELETE', { expectedVersion: parent.version }, 409);
  const childEntry = await archive(f, 'issue', child);
  const parentEntry = await archive(f, 'issue', parent);
  const commonEntry = await archive(f, 'document', common);
  const scoped = await trash(f, `?scope=project&projectId=${projectId}`);
  assert.equal(scoped.total, 2);
  assert.deepEqual(new Set(scoped.items.map(item => item.id)), new Set([childEntry.id, parentEntry.id]));
  const second = await trash(f, `?scope=project&projectId=${projectId}&offset=1`);
  assert.equal(second.total, 2);
  assert.equal(second.offset, 1);
  assert.deepEqual(second.items, scoped.items.slice(1));
  assert.deepEqual((await trash(f, '?scope=common&resourceType=document')).items, [commonEntry]);
  assert.equal((await trash(f, '?scope=common&resourceType=issue')).total, 0);
  await f.call('/trash?offset=-1', 'GET', undefined, 400);

  await restore(f, childEntry, 409);
  await f.call(trashPath(parentEntry), 'DELETE', undefined, 409);
  assert.equal((await trash(f)).total, 3);
  await restore(f, parentEntry);
  await restore(f, childEntry);
  assert.equal((await workspace(f)).issues.find(issue => issue.id === child.id)?.parentId, parent.id);
  await f.call(trashPath(commonEntry), 'DELETE');
  await restore(f, commonEntry, 404);
  assert.equal((await trash(f)).total, 0);
});

test('a moved document parent leaves its original trash entry importable and blocks child restore until it returns', async t => {
  const f = await fixture(t);
  const parent = await makeDocument(f, '프로젝트를 옮길 상위 문서');
  const child = await f.call<DocPage>('/documents', 'POST', {projectId, parentId:parent.id, title:'원래 프로젝트에서 복원할 하위 문서'}, 201);
  const entry = await archive(f, 'document', child);
  await f.call(documentPath(parent.id), 'PATCH', {expectedVersion:parent.version, projectId:'project-team'});
  const backup = await f.call<Backup>('/export');
  await f.call('/import', 'POST', {data:backup});
  await restore(f, entry, 409);
  const current = (await workspace(f)).documents.find(doc=>doc.id===parent.id)!;
  assert.equal(current.projectId,'project-team');
  await f.call(documentPath(parent.id),'PATCH',{expectedVersion:current.version,projectId});
  await restore(f, entry);
  assert.equal((await workspace(f)).documents.find(doc=>doc.id===child.id)?.parentId,parent.id);
});

test('restoring a collaborative document preserves drafts, publication snapshots and history, and invalidates the old room', async t => {
  const f = await fixture(t);
  const doc = await makeDocument(f, '휴지통 협업 문서 원본');
  const path = documentPath(doc.id);
  const publicationPath = `${path}/publication`;
  const publication = () => f.call<DocumentPublicationView>(publicationPath);
  const session = await f.call<CollaborationSession>(`${path}/collaboration/enable`, 'POST', { expectedVersion: doc.version });
  const initial = await publication();
  const review = await f.call<DocumentPublicationView>(publicationPath, 'POST', {
    action: 'request', expectedVersion: initial.version, workspaceGeneration: initial.workspaceGeneration,
    expectedDocumentVersion: session.document.version, reviewerId: reviewer,
  });
  const published = await f.call<DocumentPublicationView>(publicationPath, 'POST', {
    action: 'publish', expectedVersion: review.version, workspaceGeneration: review.workspaceGeneration,
  }, 200, reviewer);
  assert.ok(published.published);
  const publishedPath = `${publicationPath}/snapshot?kind=published&revisionId=${published.published.revisionId}`;
  const frozen = await f.call<DocRevision>(publishedPath);
  const updated = await f.call<DocPage>(path, 'PATCH', {
    expectedVersion: session.document.version, title: '휴지통 협업 문서 업데이트', content: docContent('검토보다 최신인 공동 초안'),
  });
  const inReview = await f.call<DocumentPublicationView>(publicationPath, 'POST', {
    action: 'request', expectedVersion: published.version, workspaceGeneration: published.workspaceGeneration,
    expectedDocumentVersion: updated.version, reviewerId: reviewer,
  });
  const before = await f.call<CollaborationSession>(`${path}/collaboration`);
  const revisions = await f.call<DocRevision[]>(`${path}/revisions`);
  const comment = await f.call<Comment>('/comments', 'POST', { resourceType: 'document', resourceId: doc.id, body: '휴지통 문서의 댓글' }, 201);
  const { original, latest } = await makeAttachment(f, 'document', doc.id);

  const live = openSocket(f, doc.id);
  let reopened: WebSocket | undefined;
  try {
    await once(live, 'open', { signal: AbortSignal.timeout(5000) });
    const first = message(live, 'welcome');
    live.send(JSON.stringify({ type: 'hello', epoch: before.epoch, schemaVersion: COLLABORATION_SCHEMA }));
    const originalRoom = await first;
    const closed = once(live, 'close', { signal: AbortSignal.timeout(5000) });
    const entry = await archive(f, 'document', before.document);
    assert.equal((await closed)[0], 4404);
    for (const route of [publishedPath, `${path}/revisions`, `${path}/collaboration`, contentPath(original.id)]) {
      await f.call(route, 'GET', undefined, 404);
    }
    await restore(f, entry);
    const after = await f.call<CollaborationSession>(`${path}/collaboration`);
    assert.equal(after.enabled, true);
    assert.notEqual(after.epoch, before.epoch);
    assert.equal(after.document.plainText, before.document.plainText);
    assert.ok(after.document.version > before.document.version);
    const restoredPublication = await publication();
    assert.deepEqual(restoredPublication.published, inReview.published);
    assert.deepEqual(restoredPublication.review, inReview.review);
    assert.deepEqual(await f.call<DocRevision>(publishedPath), frozen);
    const restoredRevisions = await f.call<DocRevision[]>(`${path}/revisions`);
    for (const revision of revisions) assert.deepEqual(restoredRevisions.find(candidate => candidate.id === revision.id), revision);
    assert.deepEqual(await f.call<Comment[]>(`/comments?resourceType=document&resourceId=${doc.id}`), [comment]);
    await bytes(f, contentPath(original.id), originalBytes);
    await bytes(f, contentPath(latest.currentVersionId), revisedBytes);
    await f.call(publicationPath, 'POST', {
      action: 'withdraw', expectedVersion: inReview.version, workspaceGeneration: inReview.workspaceGeneration,
    }, 409);

    reopened = openSocket(f, doc.id);
    await once(reopened, 'open', { signal: AbortSignal.timeout(5000) });
    const next = message(reopened, 'welcome');
    reopened.send(JSON.stringify({ type: 'hello', epoch: after.epoch, schemaVersion: COLLABORATION_SCHEMA }));
    const restoredRoom = await next;
    assert.equal(restoredRoom.epoch, after.epoch);
    assert.equal(restoredRoom.update, originalRoom.update);
  } finally {
    live.terminate();
    reopened?.terminate();
  }
});

test('native schema 17 retains invisible archived bytes, rejects damage, and can restore after a separate purge', async t => {
  const f = await fixture(t);
  const doc = await makeDocument(f, '휴지통 백업 첨부 문서');
  const { original, latest } = await makeAttachment(f, 'document', doc.id);
  const entry = await archive(f, 'document', doc);
  const path = join(f.dataDir, 'uploads');
  const fileIds = [original.id, latest.currentVersionId].sort();
  assert.deepEqual(readdirSync(path).sort(), fileIds);
  const backup = await f.call<Backup>('/export');
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.equal(backup.trashEntries?.length, 1);
  assert.ok(!backup.documents.some(value => value.id === doc.id));
  assert.ok(!backup.attachments.some(value => value.id === original.id));
  const exportedFiles = new Map(backup.attachmentContents.map(value => [value.id, Buffer.from(value.data, 'base64')]));
  assert.deepEqual(exportedFiles.get(original.id), originalBytes);
  assert.deepEqual(exportedFiles.get(latest.currentVersionId), revisedBytes);

  await f.restart();
  assert.deepEqual((await trash(f)).items, [entry]);
  await f.call(contentPath(original.id), 'GET', undefined, 404);
  await f.call('/import', 'POST', { data: { ...backup, schemaVersion: 16 } }, 400);
  const duplicate = structuredClone(backup);
  duplicate.trashEntries!.push(duplicate.trashEntries![0]);
  await f.call('/import', 'POST', { data: duplicate }, 400);
  const corrupt = structuredClone(backup);
  corrupt.attachmentContents.find(value => value.id === latest.currentVersionId)!.data = Buffer.from('손상된 휴지통 첨부').toString('base64');
  await f.call('/import', 'POST', { data: corrupt }, 400);
  assert.deepEqual((await trash(f)).items, [entry]);
  assert.deepEqual(readdirSync(path).sort(), fileIds);

  await f.call(trashPath(entry), 'DELETE');
  assert.deepEqual(readdirSync(path), []);
  await restore(f, entry, 404);
  await f.call('/import', 'POST', { data: backup });
  assert.deepEqual((await trash(f)).items, [entry]);
  await f.call(contentPath(original.id), 'GET', undefined, 404);
  await restore(f, entry);
  const restored = (await workspace(f)).documents.find(value => value.id === doc.id);
  assert.ok(restored && restored.version > doc.version);
  await bytes(f, contentPath(original.id), originalBytes);
  await bytes(f, versionPath(latest.currentVersionId), revisedBytes);

  const newer = await f.call<DocPage>(documentPath(doc.id), 'PATCH', { expectedVersion: restored.version, title: '백업 뒤 새 편집' });
  await f.call('/import', 'POST', { data: backup });
  await restore(f, entry);
  const restoredAgain = (await workspace(f)).documents.find(value => value.id === doc.id);
  assert.ok(restoredAgain && restoredAgain.version > newer.version);
  assert.equal(restoredAgain.title, doc.title);
  await f.call(documentPath(doc.id), 'PATCH', { expectedVersion: newer.version, title: '이전 화면에서 보낸 편집' }, 409);
  const archivedAgain = await archive(f, 'document', restoredAgain);
  assert.notEqual(archivedAgain.id, entry.id);
  await restore(f, entry, 404);
  const legacy = await f.call<Backup>('/export');
  legacy.schemaVersion = 16;
  delete legacy.trashEntries;
  legacy.attachmentContents = legacy.attachmentContents.filter(value => !fileIds.includes(value.id));
  await f.call('/import', 'POST', { data: legacy });
  assert.equal((await trash(f)).total, 0);
  assert.deepEqual(readdirSync(path), []);
});
