import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
  ApiKeyCreated, Attachment, AttachmentHead, AttachmentVersion, Comment, Dependency, DocPage, DocRevision, DocumentCommentReplyResult,
  DocumentPublicationView, DocumentSelectionCommentResult, TeamNotification,
  GitlabIssueRefreshResult, GitlabLink, GitlabSettings, GitlabSyncResult, Issue, IssueWorklogPage, Milestone, ProjectWorklogReport, ReportingLedgerData, ResourceLink, RichContent, TrashEntrySummary, TrashPage,
  TrashItemPage, TrashItemSummary, TrashResourceType, TrashRestoreResult, WebhookEndpointCreated, WorklogEntry, WorkspaceSnapshot,
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
  trashItems?: unknown[];
};
type GitlabBackup = Omit<Backup, 'trashEntries'> & { trashEntries: { id: string; gitlabLinks: GitlabLink[] }[] };
type CommentBackup = Omit<Backup, 'trashEntries' | 'trashItems'> & {
  comments: Comment[];
  teamNotifications: TeamNotification[];
  trashEntries: { id: string; comments: Comment[] }[];
  trashItems: { id: string; item: Comment; replies?: Comment[] }[];
};
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
  const dataDir = mkdtempSync(join(tmpdir(), 'donefac-trash-'));
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
const trashItems = (f: Fixture, query = '') => f.call<TrashItemPage>('/trash/items' + query);
const itemPath = (id: string) => `/trash/items/${id}`;
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

async function makeThread(f: Fixture, document: DocPage, selectedText: string) {
  const path = `${documentPath(document.id)}/selection-comments`;
  const { comment: root } = await f.call<DocumentSelectionCommentResult>(path, 'POST', {
    requestId: randomUUID(), expectedDocumentVersion: document.version,
    sourceSelection: { from: 1, to: selectedText.length + 1, text: selectedText }, body: '선택 문장에 검토 의견을 남겼습니다.',
  }, 201, reviewer);
  const reply = async (body: string, author = actor) => (await f.call<DocumentCommentReplyResult>(`${path}/${root.id}/replies`, 'POST', {
    requestId: randomUUID(), expectedResolutionVersion: 0, body,
  }, 201, author)).comment;
  return { root, reply };
}

test('individual comment trash enforces authorship and restores the same ordered discussion without redelivery', async t => {
  const f = await fixture(t);
  const issue = await makeIssue(f, '댓글 복원 검증', { assigneeId: actor });
  const input = { resourceType: 'issue', resourceId: issue.id };
  const commentList = `/comments?${new URLSearchParams(input)}`;
  const endpoint = await f.call<WebhookEndpointCreated>('/webhook-endpoints', 'POST', {
    name: '합성 댓글 발신 검증', url: 'http://127.0.0.1:1/unused', projectIds: [projectId], eventTypes: ['comment.created'],
  }, 201);
  await f.call(`/webhook-endpoints/${endpoint.endpoint.id}`, 'PATCH', { expectedVersion: endpoint.endpoint.version, enabled: true });
  const first = await f.call<Comment>('/comments', 'POST', { ...input, body: '복원할 첫 댓글' }, 201, reviewer);
  const second = await f.call<Comment>('/comments', 'POST', { ...input, body: '뒤에 남긴 댓글' }, 201, reviewer);
  const deliveries = await f.call<unknown[]>('/webhook-deliveries');
  const inbox = await f.call('/notifications');
  assert.equal(deliveries.length, 2);

  const path = `/comments/${first.id}`;
  await f.call(path, 'DELETE', undefined, 403, actor);
  assert.equal((await trashItems(f)).total, 0);
  assert.deepEqual(await f.call<Comment[]>(commentList), [first, second]);
  const { trashItemId } = await f.call<{ trashItemId: string }>(path, 'DELETE', undefined, 200, reviewer);
  assert.ok(trashItemId);
  await f.call(path, 'DELETE', undefined, 404, reviewer);
  assert.deepEqual(await f.call<Comment[]>(commentList), [second]);

  const listed = await trashItems(f, `?scope=project&projectId=${projectId}&itemType=comment&limit=1`);
  assert.equal(listed.total, 1);
  const [item] = listed.items;
  assert.ok(item);
  assert.deepEqual({ id: item.id, itemType: item.itemType, itemId: item.itemId, ownerType: item.ownerType, ownerId: item.ownerId,
    ownerTitle: item.ownerTitle, ownerIssueKey: item.ownerIssueKey, ownerAvailable: item.ownerAvailable, projectId: item.projectId,
    deletedById: item.deletedById, authorId: item.authorId, versionCount: item.versionCount }, {
    id: trashItemId, itemType: 'comment', itemId: first.id, ownerType: 'issue', ownerId: issue.id,
    ownerTitle: issue.title, ownerIssueKey: issue.key, ownerAvailable: true, projectId,
    deletedById: reviewer, authorId: reviewer, versionCount: null,
  });
  assert.ok(item.title.includes(first.body));
  assert.ok(Number.isFinite(Date.parse(item.deletedAt)));
  assert.equal((await trashItems(f, '?scope=project&projectId=project-team')).total, 0);
  assert.equal((await trashItems(f, '?scope=common')).total, 0);
  await f.call('/trash/items?itemType=comment&itemType=attachment', 'GET', undefined, 400);

  assert.equal((await f.call<TrashItemSummary>(`${itemPath(trashItemId)}/restore`, 'POST', {})).itemId, first.id);
  assert.equal((await trashItems(f)).total, 0);
  assert.deepEqual(await f.call<Comment[]>(commentList), [first, second]);
  assert.deepEqual(await f.call<unknown[]>('/webhook-deliveries'), deliveries);
  assert.deepEqual(await f.call('/notifications'), inbox);
  await f.call(`${itemPath(trashItemId)}/restore`, 'POST', {}, 404);
});

test('anchored comment replies survive individual and document trash, backup, and restore until their root is purged', async t => {
  const f = await fixture(t);
  const doc = await makeDocument(f, '답글과 원래 문서의 휴지통');
  const path = `/comments?resourceType=document&resourceId=${doc.id}`;
  const { root, reply } = await makeThread(f, doc, doc.title);
  const first = await reply('답글만 먼저 휴지통으로 보냅니다.');
  const second = await reply('나머지 답글은 문장 댓글과 함께 보관합니다.', reviewer);
  const remove = async (comment: Comment) => (await f.call<{ trashItemId: string }>(`/comments/${comment.id}`, 'DELETE', undefined, 200, comment.authorId)).trashItemId;
  const restoreItem = (id: string, status = 200) => f.call<TrashItemSummary>(`${itemPath(id)}/restore`, 'POST', {}, status);
  const backup = () => f.call<CommentBackup>('/export');
  const assertActive = async (...comments: Comment[]) => {
    const actual = await f.call<Comment[]>(path);
    assert.deepEqual(new Map(actual.map(comment => [comment.id, comment])), new Map(comments.map(comment => [comment.id, comment])));
  };
  await f.call(`/comments/${first.id}`, 'DELETE', undefined, 403, reviewer);
  await assertActive(root, first, second);

  const standalone = await remove(first);
  const entireDocument = await archive(f, 'document', doc);
  const documentCopy = await backup();
  assert.deepEqual(documentCopy.trashEntries.find(entry => entry.id === entireDocument.id)?.comments, [root, second]);
  assert.deepEqual(documentCopy.trashItems.find(item => item.id === standalone)?.item, first);
  await f.call(path, 'GET', undefined, 404);
  await f.call('/import', 'POST', { data: documentCopy });
  await restoreItem(standalone, 409);
  await restore(f, entireDocument);
  await assertActive(root, second);
  await restoreItem(standalone);
  await assertActive(root, first, second);

  const firstEntry = await remove(first);
  const rootEntry = await remove(root);
  await assertActive();
  await restoreItem(firstEntry, 409);
  const current = (await workspace(f)).documents.find(value => value.id === doc.id);
  assert.ok(current);
  const archivedOwner = await archive(f, 'document', current);
  await restoreItem(rootEntry, 409);
  const mixed = await backup();
  assert.equal(mixed.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  const bundled = mixed.trashItems.find(item => item.id === rootEntry);
  assert.ok(bundled);
  assert.deepEqual(bundled.item, root);
  assert.deepEqual(bundled.replies, [second]);
  assert.deepEqual(mixed.trashItems.find(item => item.id === firstEntry)?.item, first);
  assert.deepEqual(mixed.trashEntries.find(entry => entry.id === archivedOwner.id)?.comments, []);

  const corrupted = structuredClone(mixed);
  corrupted.trashItems.find(item => item.id === rootEntry)!.replies![0].parentCommentId = first.id;
  await f.call('/import', 'POST', { data: corrupted }, 400);
  assert.deepEqual((await backup()).trashItems, mixed.trashItems);

  await f.call('/import', 'POST', { data: mixed });
  await f.restart();
  await restore(f, archivedOwner);
  await restoreItem(firstEntry, 409);
  await restoreItem(rootEntry);
  await assertActive(root, second);
  await restoreItem(firstEntry);
  await assertActive(root, first, second);
  assert.deepEqual((await backup()).teamNotifications.filter(row => row.kind === 'document-comment-reply'),
    mixed.teamNotifications.filter(row => row.kind === 'document-comment-reply'));

  const removedReply = await remove(first);
  const removedRoot = await remove(root);
  await f.call(itemPath(removedRoot), 'DELETE');
  await restoreItem(removedReply, 404);
  assert.equal((await trashItems(f)).total, 0);
  await assertActive();
  await f.call('/import', 'POST', { data: await backup() });
});

test('native reply topology rejects corrupted links atomically and API keys respect the original revision scope', async t => {
  const f = await fixture(t);
  const outside = 'project-team';
  const quote = '프로젝트 범위의 댓글 원문';
  const content = docContent(quote);
  content.content!.push({ type: 'issueSummary', attrs: { projectId: outside, savedViewId: null, label: '외부 프로젝트', groupBy: 'status' } });
  const document = await f.call<DocPage>('/documents', 'POST', { projectId, title: quote, content }, 201);
  const { root, reply } = await makeThread(f, document, quote);
  const child = await reply('원문을 조회할 수 있는 키만 이 답글을 받습니다.');
  const path = `/comments?resourceType=document&resourceId=${document.id}`;
  const publicComments = async (name: string, projectIds: string[]) => {
    const key = await f.call<ApiKeyCreated>('/api-keys', 'POST', { name, access: 'read', projectIds }, 201);
    const response = await f.request(`/v1${path}`, { headers: { Authorization: `Bearer ${key.token}` } });
    assert.equal(response.status, 200);
    return await response.json() as Comment[];
  };
  const { documentSource, ...redactedRoot } = root;
  assert.ok(documentSource);
  assert.deepEqual(await publicComments('원문을 볼 수 없는 합성 키', [projectId]), [redactedRoot]);
  assert.deepEqual(await publicComments('두 프로젝트 모두 볼 수 있는 합성 키', [projectId, outside]), [root, child]);

  const data = await f.call<CommentBackup>('/export');
  const legacy = { ...data, schemaVersion: 76 };
  const wrongParent = data.comments.map(comment => comment.id === child.id ? { ...comment, parentCommentId: child.id } : comment);
  const duplicatedPin = data.comments.map(comment => comment.id === child.id ? { ...comment, documentSource } : comment);
  const elsewhere = {
    ...data,
    comments: data.comments.filter(comment => comment.id !== root.id),
    trashItems: [...data.trashItems, { id: randomUUID(), itemType: 'comment', ownerType: 'document', ownerId: document.id,
      title: root.body, deletedAt: new Date().toISOString(), deletedById: reviewer, item: root, versions: [] }],
  };
  for (const corrupt of [legacy, { ...data, comments: wrongParent }, { ...data, comments: duplicatedPin }, elsewhere]) {
    await f.call('/import', 'POST', { data: corrupt }, 400);
    assert.deepEqual(await f.call<Comment[]>(path), [root, child]);
    assert.equal((await trashItems(f)).total, 0);
  }
  await f.call('/import', 'POST', { data: {
    ...legacy, comments: data.comments.filter(comment => comment.id !== child.id),
    teamNotifications: data.teamNotifications.filter(row => row.commentId !== child.id),
  } });
  assert.deepEqual(await f.call<Comment[]>(path), [root]);
});

test('individual attachment and comment archives survive restart and backup; parent restore and purge preserve their lifecycle', async t => {
  const f = await fixture(t);
  const doc = await makeDocument(f, '개별 휴지통과 상위 문서 검증');
  const { original, latest } = await makeAttachment(f, 'document', doc.id);
  const fileIds = [original.id, latest.currentVersionId];
  const files = await f.call<AttachmentVersion[]>(`/attachments/${original.id}/versions`);
  const attachmentList = `/attachments?resourceType=document&resourceId=${doc.id}`;
  const commentList = `/comments?resourceType=document&resourceId=${doc.id}`;
  const comment = await f.call<Comment>('/comments', 'POST', { resourceType: 'document', resourceId: doc.id, body: '분리하여 보관할 댓글' }, 201, reviewer);

  await f.call(`/attachments/${original.id}?expectedVersionId=${original.id}`, 'DELETE', undefined, 409);
  const db = new DatabaseSync(join(f.dataDir, 'donefac.sqlite'));
  try {
    db.exec("CREATE TRIGGER fail_item_trash_audit BEFORE INSERT ON activities BEGIN SELECT RAISE(ABORT,'synthetic item rollback'); END");
    await f.call(`/attachments/${original.id}`, 'DELETE', undefined, 500);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS fail_item_trash_audit');
    db.close();
  }
  assert.deepEqual(await f.call(attachmentList), [latest]);
  assert.equal((await trashItems(f)).total, 0);

  const { trashItemId: attachmentEntry } = await f.call<{ trashItemId: string }>(`/attachments/${original.id}?expectedVersionId=${latest.currentVersionId}`, 'DELETE');
  const { trashItemId: commentEntry } = await f.call<{ trashItemId: string }>(`/comments/${comment.id}`, 'DELETE', undefined, 200, reviewer);
  const [attachment] = (await trashItems(f, '?itemType=attachment')).items;
  assert.equal(attachment.id, attachmentEntry);
  assert.equal(attachment.title, latest.filename);
  assert.equal(attachment.versionCount, 2);
  assert.equal(attachment.ownerAvailable, true);
  assert.deepEqual(await f.call(attachmentList), []);
  assert.deepEqual(await f.call(commentList), []);
  await f.call(`/attachments/${original.id}/versions`, 'GET', undefined, 404);
  for (const id of fileIds) {
    await f.call(contentPath(id), 'GET', undefined, 404);
    await f.call(versionPath(id), 'GET', undefined, 404);
  }
  assert.deepEqual(readdirSync(join(f.dataDir, 'uploads')).sort(), [...fileIds].sort());

  const key = await f.call<ApiKeyCreated>('/api-keys', 'POST', { name: '개별 휴지통 공개 경계', access: 'write', projectIds: [projectId], expiresAt: null }, 201);
  const headers = { Authorization: `Bearer ${key.token}` };
  assert.equal((await f.request(`/v1${contentPath(latest.currentVersionId)}`, { headers })).status, 404);
  assert.equal((await f.request('/v1/trash/items', { headers })).status, 403);
  assert.equal((await f.request(`/v1${itemPath(attachmentEntry)}/restore`, { method: 'POST', headers })).status, 403);

  const owner = await archive(f, 'document', doc);
  assert.equal((await trashItems(f)).total, 2);
  assert.ok((await trashItems(f)).items.every(item => !item.ownerAvailable && item.ownerId === doc.id));
  await f.call(`${itemPath(attachmentEntry)}/restore`, 'POST', {}, 409);
  await f.call(`${itemPath(commentEntry)}/restore`, 'POST', {}, 409);
  const originalBackup = await f.call<Backup>('/export');
  assert.equal(originalBackup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.equal(originalBackup.trashItems?.length, 2);
  assert.deepEqual(new Map(originalBackup.attachmentContents.map(item => [item.id, Buffer.from(item.data, 'base64')])), new Map([
    [original.id, originalBytes], [latest.currentVersionId, revisedBytes],
  ]));
  await f.call('/import', 'POST', { data: { ...originalBackup, schemaVersion: 30 } }, 400);
  const duplicate = structuredClone(originalBackup);
  duplicate.trashItems!.push(duplicate.trashItems![0]);
  await f.call('/import', 'POST', { data: duplicate }, 400);
  const corrupt = structuredClone(originalBackup);
  corrupt.attachmentContents.find(item => item.id === latest.currentVersionId)!.data = Buffer.from('변조된 합성 첨부').toString('base64');
  await f.call('/import', 'POST', { data: corrupt }, 400);
  assert.equal((await trashItems(f)).total, 2);

  await f.call('/import', 'POST', { data: originalBackup });
  await f.restart();
  await restore(f, owner);
  assert.deepEqual(await f.call(attachmentList), []);
  assert.deepEqual(await f.call(commentList), []);
  assert.ok((await trashItems(f)).items.every(item => item.ownerAvailable));
  const latestPath = join(f.dataDir, 'uploads', latest.currentVersionId);
  try {
    writeFileSync(latestPath, Buffer.from('복원 직전 손상된 합성 첨부'));
    await f.call(`${itemPath(attachmentEntry)}/restore`, 'POST', {}, 503);
    assert.deepEqual(await f.call(attachmentList), []);
    assert.equal((await trashItems(f, '?itemType=attachment')).items[0]?.id, attachmentEntry);
  } finally { writeFileSync(latestPath, revisedBytes); }
  await f.call(`${itemPath(attachmentEntry)}/restore`, 'POST', {});
  await f.call(`${itemPath(commentEntry)}/restore`, 'POST', {});
  assert.deepEqual(await f.call<Comment[]>(commentList), [comment]);
  assert.deepEqual(await f.call(attachmentList), [latest]);
  assert.deepEqual(await f.call(`/attachments/${original.id}/versions`), files);
  await bytes(f, contentPath(original.id), originalBytes);
  await bytes(f, versionPath(latest.currentVersionId), revisedBytes);

  await f.call(`/attachments/${original.id}`, 'DELETE');
  await f.call(`/comments/${comment.id}`, 'DELETE', undefined, 200, reviewer);
  const current = (await workspace(f)).documents.find(row => row.id === doc.id)!;
  const parentPurge = await archive(f, 'document', current);
  await f.call(trashPath(parentPurge), 'DELETE');
  assert.equal((await trashItems(f)).total, 0);
  assert.deepEqual(readdirSync(join(f.dataDir, 'uploads')), []);
});

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

test('schema 102 preserves exact branch refreshes as the push baseline for live and archived links', async t => {
  const f = await fixture(t);
  const live = await makeIssue(f, '조회 후 백업할 브랜치');
  const archived = await makeIssue(f, '조회 후 휴지통에 둘 브랜치');
  const firstHead = 'a'.repeat(40), checkedHead = 'b'.repeat(40), newHead = 'c'.repeat(40), zero = '0'.repeat(40);
  const branch = (issue: Issue) => `release/${issue.key}`;
  const projectPath = '/forge/api/v4/projects/42';
  const token = 'synthetic-exact-branch-read';
  const mock = createServer((req, res) => {
    assert.equal(req.headers['private-token'], token);
    const issue = [live, archived].find(issue => req.url === `${projectPath}/repository/branches/${encodeURIComponent(branch(issue))}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === projectPath) res.end(JSON.stringify({ id: 42, web_url: `${baseUrl}/team/engine` }));
    else if (issue) res.end(JSON.stringify({ name: branch(issue), commit: { id: checkedHead } }));
    else res.writeHead(404).end();
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
  const webhookSecret = 'synthetic-exact-branch-backup';
  const { version } = await f.call<GitlabSettings>('/integrations/gitlab');
  await f.call('/integrations/gitlab', 'PATCH', { expectedVersion: version, baseUrl, projectIds: [42], token, webhookSecret });
  async function push(issue: Issue, before: string, after: string) {
    const response = await f.request('/integrations/gitlab/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Gitlab-Token': webhookSecret, 'X-Gitlab-Event': 'Push Hook', 'webhook-id': randomUUID() },
      body: JSON.stringify({ object_kind: 'push', project_id: 42, ref: `refs/heads/${branch(issue)}`, before, after,
        checkout_sha: after === zero ? null : after, commits: [], total_commits_count: 0,
        project: { id: 42, path_with_namespace: 'team/engine' } }),
    });
    assert.equal(response.status, 200, await response.text());
  }

  for (const issue of [live, archived]) {
    await push(issue, zero, firstHead);
    const { links, failures } = await f.call<GitlabIssueRefreshResult>(`/issues/${issue.id}/gitlab-links/refresh`, 'POST', {});
    assert.deepEqual(failures, []);
    assert.deepEqual(links.map(link => [link.sourceSha, link.branchObservationSource]), [[checkedHead, 'read']]);
  }
  const entry = await archive(f, 'issue', archived);
  const backup = await f.call<GitlabBackup>('/export');
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  const liveLink = backup.gitlabLinks.find(link => link.issueId === live.id);
  const archivedLink = branchInTrash(backup, entry);
  assert.ok(liveLink && archivedLink);
  assert.equal(liveLink.branchObservationSource, 'read');
  assert.equal(archivedLink.branchObservationSource, 'read');

  const unsupported = await f.call<{ error: string }>('/import', 'POST', { data: { ...backup, schemaVersion: 101 } }, 400);
  assert.match(unsupported.error, /schemaVersion 102/u);
  const corrupt = structuredClone(backup);
  corrupt.gitlabLinks.find(link => link.id === liveLink.id)!.id = liveLink.id.replace(/:branch:[a-f\d]{64}:/u, `:branch:${'0'.repeat(64)}:`);
  await f.call('/import', 'POST', { data: corrupt }, 400);
  const legacy = structuredClone(backup);
  legacy.schemaVersion = 101;
  legacy.gitlabLinks.find(link => link.id === liveLink.id)!.branchObservationSource = 'sync';
  branchInTrash(legacy, entry)!.branchObservationSource = 'sync';
  await f.call('/import', 'POST', { data: legacy });
  await f.call('/import', 'POST', { data: backup });
  await f.restart();
  const restoredBackup = await f.call<GitlabBackup>('/export');
  assert.deepEqual(restoredBackup.gitlabLinks.find(link => link.id === liveLink.id), liveLink);
  assert.deepEqual(branchInTrash(restoredBackup, entry), archivedLink);

  await push(live, firstHead, 'd'.repeat(40));
  assert.deepEqual((await workspace(f)).gitlabLinks.find(link => link.id === liveLink.id), liveLink);
  await push(live, checkedHead, newHead);
  await push(archived, checkedHead, zero);
  const current = (await workspace(f)).gitlabLinks.find(link => link.id === liveLink.id);
  assert.equal(current?.sourceSha, newHead);
  assert.equal(current?.branchObservationSource, undefined);
  const deleted = branchInTrash(await f.call<GitlabBackup>('/export'), entry);
  assert.equal(deleted?.state, 'deleted');
  assert.equal(deleted?.sourceSha, checkedHead);
  assert.equal(deleted?.branchObservationSource, undefined);
  await restore(f, entry);
  assert.deepEqual((await workspace(f)).gitlabLinks.find(link => link.issueId === archived.id), deleted);
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
  const observer = new DatabaseSync(join(f.dataDir, 'donefac.sqlite'));
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

test('permanent deletion resumes pending file cleanup on restart', async t => {
  const f = await fixture(t);
  const issue = await makeIssue(f, '재시작 시 첨부 정리 검증');
  const { original, latest } = await makeAttachment(f, 'issue', issue.id);
  const archived = await f.call<{ trashItemId: string }>(`/attachments/${original.id}?expectedVersionId=${latest.currentVersionId}`, 'DELETE');
  const originalPath = join(f.dataDir, 'uploads', original.id);
  const heldPath = join(f.dataDir, 'interrupted-upload-cleanup');
  renameSync(originalPath, heldPath);
  mkdirSync(originalPath); // Force the immediate unlink to fail after the database commit.
  await f.call(itemPath(archived.trashItemId), 'DELETE');
  assert.ok(existsSync(originalPath));
  assert.equal((await trashItems(f)).total, 0);
  await f.call(contentPath(original.id), 'GET', undefined, 404);
  rmSync(originalPath, { recursive: true });
  renameSync(heldPath, originalPath);
  await f.restart();
  assert.ok(!existsSync(originalPath));
  assert.ok(!existsSync(join(f.dataDir, 'uploads', latest.currentVersionId)));
  await f.call(`${itemPath(archived.trashItemId)}/restore`, 'POST', {}, 404);
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
