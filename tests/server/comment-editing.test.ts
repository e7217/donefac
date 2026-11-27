import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { DOCUMENT_CONTENT_SCHEMA_VERSION } from '../../shared/document-nodes.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type {
  ApiKeyCreated, Comment, CommentEditResult, CommentEditSnapshot, CommentMention, DocPage, DocumentCommentReplyResult, DocumentSelectionCommentResult,
  Issue, TeamNotificationPage, User, WorkspaceSnapshot,
} from '../../shared/types.js';

const author = 'user-min';
const reviewer = 'user-seo';
const participant = 'user-jun';
const outsider = 'user-yun';
const projectId = 'project-neo';
const otherProjectId = 'project-team';
const quote = '교정할 원문 문장';
const pathFor = (comment: Comment) => `/comments/${comment.id}`;
const resolutionPath = (comment: Comment) => `/documents/${comment.resourceId}/selection-comments/${comment.id}/resolution`;

type Backup = WorkspaceSnapshot & {
  schemaVersion: number;
  comments: Comment[];
  trashEntries: { id: string; comments: Comment[] }[];
  trashItems: { id: string; item: Comment; replies?: Comment[] }[];
};
type RequestOptions = { method?: string; body?: unknown; actor?: string; headers?: Record<string, string> };

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'donefac-comment-edit-'));
  async function start() {
    const app = createApp({ dataDir: directory, outboundWorker: false, deadlineReminderWorker: false });
    const server = app.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { app, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api` };
  }
  let service = await start();
  async function close() {
    service.server.closeAllConnections();
    try {
      await new Promise<void>((resolve, reject) => service.server.close(error => error ? reject(error) : resolve()));
    } finally { service.app.close(); }
  }
  t.after(async () => {
    try { await close(); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  });

  async function request<T = unknown>(path: string, { method = 'GET', body, actor = author, headers }: RequestOptions = {}) {
    const response = await fetch(service.base + path, {
      method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actor, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, cache: response.headers.get('Cache-Control'), data: await response.json() as T };
  }
  async function call<T = unknown>(path: string, options?: RequestOptions, status = 200) {
    const response = await request<T>(path, options);
    assert.equal(response.status, status, `${options?.method ?? 'GET'} ${path}: ${JSON.stringify(response.data)}`);
    return response.data;
  }
  const { users } = await call<WorkspaceSnapshot>('/workspace');
  const member = (id: string) => users.find(user => user.id === id)!;
  const issue = (title: string) => call<Issue>('/issues', {
    method: 'POST', body: { title, projectId, reporterId: author, assigneeId: reviewer, collaboratorIds: [participant] },
  }, 201);
  const document = (title: string, project: string | null = projectId) => call<DocPage>('/documents', {
    method: 'POST', actor: reviewer, body: { title, projectId: project, content: {
      type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: quote }] }],
    } },
  }, 201);
  const comment = (resourceType: Comment['resourceType'], resourceId: string, body: string, mentions?: CommentMention[]) =>
    call<Comment>('/comments', { method: 'POST', body: { resourceType, resourceId, body, mentions } }, 201);
  const list = (resourceType: Comment['resourceType'], resourceId: string) =>
    call<Comment[]>(`/comments?resourceType=${resourceType}&resourceId=${resourceId}`);
  const begin = (value: Comment, options?: RequestOptions, status = 200) => call<CommentEditSnapshot>(`${pathFor(value)}/edit`, options, status);
  const put = (value: Comment, body: unknown, options?: RequestOptions, status = 200) =>
    call<CommentEditResult>(pathFor(value), { ...options, method: 'PATCH', body }, status);
  const restore = (data: Backup, status = 200) => call<{ error?: string }>('/import', { method: 'POST', body: { data } }, status);
  const backup = () => call<Backup>('/export');
  const inbox = async (actor: string, commentId: string) =>
    (await call<TeamNotificationPage>('/notifications', { actor })).items.filter(item => item.commentId === commentId);
  const restart = async () => { await close(); service = await start(); };
  return { directory, request, call, member, issue, document, comment, list, begin, put, restore, backup, inbox, restart };
}

function compose(...parts: (string | User)[]) {
  let body = '';
  const mentions: CommentMention[] = [];
  for (const part of parts) {
    if (typeof part === 'string') body += part;
    else {
      const from = body.length;
      body += `@${part.name}`;
      mentions.push({ userId: part.id, from, to: body.length });
    }
  }
  return { body, mentions };
}

function update(snapshot: CommentEditSnapshot, body: string, mentions?: CommentMention[]) {
  return { requestId: randomUUID(), editToken: snapshot.editToken, body, mentions };
}

test('author edits are versioned, retry-safe, and notify only new mentions while keeping existing links', async t => {
  const f = await fixture(t);
  const issue = await f.issue('댓글을 교정할 업무');
  const original = compose(f.member(reviewer), ' 검토 전 초안');
  const comment = await f.comment('issue', issue.id, original.body, original.mentions);
  const before = await f.request<CommentEditSnapshot>(`${pathFor(comment)}/edit`);
  assert.equal(before.status, 200);
  assert.equal(before.cache, 'no-store');
  assert.deepEqual(before.data.comment, comment);
  assert.ok(before.data.editToken);
  await f.begin(comment, { actor: reviewer }, 403);
  const input = update(before.data, '다른 작성자가 변경할 수 없는 댓글');
  await f.put(comment, input, { actor: reviewer }, 403);
  await f.put(comment, { ...input, authorId: reviewer }, undefined, 400);
  await f.put(comment, { ...input, body: '  ' }, undefined, 400);
  await f.put(comment, { ...input, requestId: 'invalid' }, undefined, 400);
  assert.deepEqual(await f.list('issue', issue.id), [comment]);

  await f.call(`/users/${reviewer}`, { method: 'PATCH', body: { name: '새 검토자 이름' } });
  const next = compose('검토 결과 ', f.member(reviewer), ' 유지. ', f.member(outsider), ' 추가 확인.');
  const firstEdit = update(before.data, next.body, next.mentions);
  const staleEdit = update(before.data, '같은 댓글 두 번째 탭에서 변경');
  const beforeActivities = (await f.call<WorkspaceSnapshot>('/workspace')).activities;
  const beforeOutsider = await f.inbox(outsider, comment.id);
  const beforeReviewer = await f.inbox(reviewer, comment.id);
  const beforeParticipant = await f.inbox(participant, comment.id);
  const database = new DatabaseSync(join(f.directory, 'donefac.sqlite'));
  try {
    database.exec(`CREATE TRIGGER fail_comment_edit_mention BEFORE INSERT ON team_notifications
      WHEN new.kind='issue-comment-mentioned'
      BEGIN SELECT RAISE(ABORT, 'synthetic comment edit rollback'); END`);
    await f.put(comment, firstEdit, undefined, 500);
    assert.deepEqual(await f.list('issue', issue.id), [comment]);
    assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).activities, beforeActivities);
    assert.deepEqual(await f.inbox(outsider, comment.id), beforeOutsider);
  } finally {
    database.exec('DROP TRIGGER IF EXISTS fail_comment_edit_mention');
    database.close();
  }

  const saved = await f.put(comment, firstEdit);
  assert.equal(saved.duplicate, false);
  assert.equal(saved.comment.id, comment.id);
  assert.equal(saved.comment.authorId, comment.authorId);
  assert.equal(saved.comment.createdAt, comment.createdAt);
  assert.equal(saved.comment.body, next.body);
  assert.deepEqual(saved.comment.mentions, next.mentions);
  assert.equal(saved.comment.editVersion, 1);
  assert.ok(Date.parse(saved.comment.editedAt!) >= Date.parse(comment.createdAt));
  assert.notEqual(saved.editToken, before.data.editToken);
  const stale = await f.request<{ details: { reason: string } }>(pathFor(comment), { method: 'PATCH', body: staleEdit });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.details.reason, 'comment_edit_conflict');
  assert.deepEqual(await f.inbox(reviewer, comment.id), beforeReviewer);
  assert.deepEqual(await f.inbox(participant, comment.id), beforeParticipant);
  const added = await f.inbox(outsider, comment.id);
  assert.equal(added.length, beforeOutsider.length + 1);
  assert.equal(added[0].kind, 'issue-comment-mentioned');
  assert.equal(added[0].targetId, issue.id);
  assert.equal(added[0].commentId, comment.id);
  const afterActivities = (await f.call<WorkspaceSnapshot>('/workspace')).activities;
  assert.equal(afterActivities.length, beforeActivities.length + 1);
  await f.restart();
  assert.deepEqual(await f.put(comment, firstEdit), { ...saved, duplicate: true });
  await f.put(comment, { ...firstEdit, body: '같은 요청 ID의 다른 내용', mentions: [] }, undefined, 409);
  const noChange = await f.put(comment, update(saved, saved.comment.body, saved.comment.mentions));
  assert.deepEqual(noChange.comment, saved.comment);
  assert.equal(noChange.editToken, saved.editToken);
  assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).activities, afterActivities);
  assert.deepEqual(await f.inbox(outsider, comment.id), added);

  const removedMention = await f.put(comment, update(saved, '멘션을 제거한 교정문', []));
  assert.equal(removedMention.comment.mentions, undefined);
  assert.equal(removedMention.comment.editVersion, 2);
  assert.deepEqual(await f.put(comment, firstEdit), { ...removedMention, duplicate: true });
  assert.deepEqual(await f.inbox(outsider, comment.id), added);
  const backup = await f.backup();
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.ok(backup.schemaVersion >= 89);
  await f.restore(backup);
  const restored = await f.begin(comment);
  assert.equal(restored.comment.body, removedMention.comment.body);
  assert.equal(restored.comment.editedAt, removedMention.comment.editedAt);
  assert.equal(restored.comment.editVersion, removedMention.comment.editVersion);
  assert.notEqual(restored.editToken, removedMention.editToken);
  assert.deepEqual(await f.inbox(outsider, comment.id), added);
  await f.put(comment, update(removedMention, '복원 직전 탭에서 저장'), undefined, 409);
  assert.equal((await f.list('issue', issue.id))[0].body, removedMention.comment.body);
});

test('ordinary document, pinned and reply edits preserve both kinds of trash, resolution and source links', async t => {
  const source = await fixture(t);
  const target = await fixture(t);
  const document = await source.document('서로 연결된 교정 검토');
  const plain = await source.comment('document', document.id, '문서 전체 댓글 원문');
  const rootPath = `/documents/${document.id}/selection-comments`;
  const rootInput = { requestId: randomUUID(), expectedDocumentVersion: document.version,
    sourceSelection: { from: 1, to: quote.length + 1, text: quote }, body: '문장 댓글 원문' };
  const root = (await source.call<DocumentSelectionCommentResult>(rootPath, { method: 'POST', body: rootInput }, 201)).comment;
  const replyPath = `${rootPath}/${root.id}/replies`;
  const replyInput = { requestId: randomUUID(), expectedResolutionVersion: 0, body: '문장에 대한 첫 답글' };
  const reply = (await source.call<DocumentCommentReplyResult>(replyPath, { method: 'POST', body: replyInput, actor: participant }, 201)).comment;
  const rootEdit = await source.begin(root);
  const resolved = await source.call<Comment>(resolutionPath(root), { method: 'PATCH', actor: reviewer,
    body: { expectedVersion: 0, state: 'resolved' } });
  const rootSaved = await source.put(root, update(rootEdit, '문장 댓글 교정'));
  assert.deepEqual(rootSaved.comment.documentSource, root.documentSource);
  assert.deepEqual(rootSaved.comment.resolution, resolved.resolution);
  assert.equal(rootSaved.comment.createdAt, root.createdAt);
  const savedPlain = await source.put(plain, update(await source.begin(plain), '문서 전체 댓글 교정'));
  assert.equal(savedPlain.comment.documentSource, undefined);
  const savedReply = await source.put(reply, update(await source.begin(reply, { actor: participant }), '답글 교정'), { actor: participant });
  assert.equal(savedReply.comment.parentCommentId, root.id);
  assert.equal(savedReply.comment.createdAt, reply.createdAt);
  assert.equal(savedReply.comment.documentSource, undefined);
  const after = await source.list('document', document.id);
  for (const saved of [rootSaved, savedPlain, savedReply]) assert.deepEqual(after.find(row => row.id === saved.comment.id), saved.comment);
  const pinned = await source.call<{ plainText: string }>(`/documents/${document.id}/include-revisions/${root.documentSource!.revisionId}`);
  assert.ok(pinned.plainText.includes(quote));
  for (const [path, body, actor] of [[rootPath, rootInput, author], [replyPath, replyInput, participant]] as const) {
    const replay = await source.request<{ comment?: Comment; duplicate?: boolean }>(path, { method: 'POST', body, actor });
    assert.ok(replay.status === 200 && replay.data.duplicate || replay.status === 409, JSON.stringify(replay));
  }
  assert.deepEqual(await source.list('document', document.id), after);

  const { trashItemId } = await source.call<{ trashItemId: string }>(pathFor(root), { method: 'DELETE' });
  const { trashEntryId } = await source.call<{ trashEntryId: string }>(`/documents/${document.id}`, {
    method: 'DELETE', actor: reviewer, body: { expectedVersion: document.version },
  });
  const archive = await source.backup();
  assert.deepEqual(archive.trashItems.find(row => row.id === trashItemId)?.item, rootSaved.comment);
  assert.deepEqual(archive.trashItems.find(row => row.id === trashItemId)?.replies, [savedReply.comment]);
  assert.deepEqual(archive.trashEntries.find(row => row.id === trashEntryId)?.comments, [savedPlain.comment]);
  await target.restore({ ...archive, schemaVersion: 88 }, 400);
  const invalid = structuredClone(archive);
  invalid.trashItems.find(row => row.id === trashItemId)!.replies![0].editVersion = -1;
  await target.restore(invalid, 400);
  await target.restore(archive);
  await target.begin(root, undefined, 404);
  await target.call(`/trash/${trashEntryId}/restore`, { method: 'POST', body: {} });
  await target.call(`/trash/items/${trashItemId}/restore`, { method: 'POST', body: {} });
  const restored = await target.list('document', document.id);
  assert.equal(restored.length, 3);
  for (const saved of [rootSaved, savedPlain, savedReply]) {
    const comment = restored.find(row => row.id === saved.comment.id);
    assert.equal(comment?.body, saved.comment.body);
    assert.equal(comment?.editedAt, saved.comment.editedAt);
    assert.equal(comment?.editVersion, saved.comment.editVersion);
    assert.equal(comment?.createdAt, saved.comment.createdAt);
    assert.equal(comment?.parentCommentId, saved.comment.parentCommentId);
    assert.deepEqual(comment?.documentSource, saved.comment.documentSource);
  }
  assert.equal(restored.find(row => row.id === root.id)?.resolution?.state, 'resolved');
  assert.equal((await target.begin(savedReply.comment, { actor: participant })).comment.body, savedReply.comment.body);
});

test('comment edit tokens and writes require a scoped write key created by the author', async t => {
  const f = await fixture(t);
  const issue = await f.issue('프로젝트 범위의 업무 댓글');
  const comment = await f.comment('issue', issue.id, '업무 댓글 내용');
  const valid = await f.begin(comment);
  const input = update(valid, '공개 API로 댓글 교정');
  async function key(name: string, owner: string, access: 'read' | 'write', projectIds: string[]) {
    const { token } = await f.call<ApiKeyCreated>('/api-keys', { method: 'POST', actor: owner, body: { name, access, projectIds } }, 201);
    return { headers: { Authorization: `Bearer ${token}` } };
  }
  const reader = await key('읽기 댓글 검사', author, 'read', [projectId]);
  const writer = await key('작성 댓글 검사', author, 'write', [projectId]);
  const wrongScope = await key('다른 프로젝트 댓글 검사', author, 'write', [otherProjectId]);
  const otherActor = await key('다른 작성자 댓글 검사', reviewer, 'write', [projectId]);
  for (const options of [reader, wrongScope, otherActor]) {
    await f.call(`/v1${pathFor(comment)}/edit`, { ...options, actor: author }, 403);
    await f.call(`/v1${pathFor(comment)}`, { ...options, actor: author, method: 'PATCH', body: input }, 403);
  }
  const viaKey = await f.call<CommentEditSnapshot>(`/v1${pathFor(comment)}/edit`, { ...writer, actor: reviewer });
  assert.deepEqual(viaKey.comment, comment);
  const saved = await f.call<CommentEditResult>(`/v1${pathFor(comment)}`, {
    ...writer, actor: reviewer, method: 'PATCH', body: update(viaKey, input.body),
  });
  assert.equal(saved.comment.authorId, author);
  assert.equal(saved.comment.body, input.body);
  const common = await f.document('공통 공간 댓글 범위', null);
  const commonComment = await f.comment('document', common.id, '공통 댓글 원문');
  await f.call(`/v1${pathFor(commonComment)}/edit`, writer, 403);
  assert.deepEqual(await f.list('issue', issue.id), [saved.comment]);

  const document = await f.document('접근 범위가 다른 내용이 포함된 문서');
  const content = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: quote }] },
    { type: 'issueSummary', attrs: { projectId: otherProjectId, savedViewId: null, label: '다른 프로젝트', groupBy: 'status' } },
  ] };
  const currentDocument = await f.call<DocPage>(`/documents/${document.id}`, {
    method: 'PATCH', actor: reviewer, body: { expectedVersion: document.version, content },
  });
  const rootPath = `/documents/${document.id}/selection-comments`;
  const { comment: root } = await f.call<DocumentSelectionCommentResult>(rootPath, {
    method: 'POST', body: { requestId: randomUUID(), expectedDocumentVersion: currentDocument.version,
      sourceSelection: { from: 1, to: quote.length + 1, text: quote }, body: '선택 본문에 남긴 의견' },
  }, 201);
  const { comment: reply } = await f.call<DocumentCommentReplyResult>(`${rootPath}/${root.id}/replies`, {
    method: 'POST', body: { requestId: randomUUID(), expectedResolutionVersion: 0, body: '원래 의견에 남긴 답글' },
  }, 201);
  // After the current document becomes disclosable, the pinned historical revision still needs the broader scope.
  await f.call(`/documents/${document.id}`, { method: 'PATCH', actor: reviewer,
    body: { expectedVersion: currentDocument.version, contentSchemaVersion: DOCUMENT_CONTENT_SCHEMA_VERSION, content: document.content } });
  const wideWriter = await key('두 프로젝트 댓글 검사', author, 'write', [projectId, otherProjectId]);
  for (const pinned of [root, reply]) {
    const snapshot = await f.begin(pinned);
    const apiPath = `/v1${pathFor(pinned)}`;
    const changes = update(snapshot, '범위가 검증된 의견 교정');
    await f.call(`${apiPath}/edit`, writer, 403);
    await f.call(apiPath, { ...writer, method: 'PATCH', body: changes }, 403);
    assert.deepEqual(await f.call(`${apiPath}/edit`, wideWriter), snapshot);
    const updated = await f.call<CommentEditResult>(apiPath, { ...wideWriter, method: 'PATCH', body: changes });
    assert.equal(updated.comment.body, changes.body);
  }
});
