import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { COMMENT_MENTION_NOTIFICATION_KINDS, MAX_COMMENT_MENTIONS } from '../../shared/types.js';
import type {
  Comment, CommentMention, DocPage, DocRevision, DocumentSelectionCommentResult, Issue,
  TeamNotification, TeamNotificationPage, User, WorkspaceSnapshot,
} from '../../shared/types.js';

const writer = 'user-min';
const reviewer = 'user-seo';
const collaborator = 'user-jun';
const unassociated = 'user-yun';
const projectId = 'project-neo';
const pinText = '검토 대상 문장';
const mentionKinds: ReadonlySet<string> = new Set(COMMENT_MENTION_NOTIFICATION_KINDS);

type Backup = WorkspaceSnapshot & {
  schemaVersion: number;
  comments: Comment[];
  teamNotifications: TeamNotification[];
  trashEntries: { id: string; comments: Comment[] }[];
  trashItems: { id: string; item: Comment }[];
};

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teamspace-comment-mentions-'));
  const app = createApp({ dataDir: directory, outboundWorker: false, deadlineReminderWorker: false });
  const server = app.app.listen(0, '127.0.0.1');
  t.after(async () => {
    try {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } finally {
      app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  async function call<T = unknown>(path: string, options: { method?: string; body?: unknown; actor?: string; status?: number } = {}) {
    const { method = 'GET', body, actor = writer, status = 200 } = options;
    const response = await fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actor },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json() as T;
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
    return data;
  }
  const { users } = await call<WorkspaceSnapshot>('/workspace');
  return {
    directory, call,
    user: (id: string) => users.find(user => user.id === id)!,
    issue: (title: string) => call<Issue>('/issues', { method: 'POST', status: 201,
      body: { title, projectId, assigneeId: reviewer, collaboratorIds: [collaborator] } }),
    document: (title: string) => call<DocPage>('/documents', { method: 'POST', status: 201, actor: reviewer,
      body: { title, projectId: null, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: pinText }] }] } } }),
    async inbox(actor: string, targetId: string) {
      const { items } = await call<TeamNotificationPage>('/notifications', { actor });
      return items.filter(item => item.targetId === targetId && item.kind.includes('-comment'));
    },
    list: (resourceType: 'issue' | 'document', resourceId: string) => call<Comment[]>(`/comments?resourceType=${resourceType}&resourceId=${resourceId}`),
    restore: (data: Backup, status = 200) => call<{ error?: string }>('/import', { method: 'POST', body: { data }, status }),
  };
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

test('regular issue and document comments notify selected IDs once and preserve ordinary comment delivery', async t => {
  const f = await fixture(t);
  const issue = await f.issue('업무 댓글 멘션');
  const document = await f.document('문서 댓글 멘션');
  const outsider = f.user(unassociated);
  const sameName = await f.call<User>('/users', { method: 'POST', status: 201,
    body: { name: outsider.name, email: 'mention-name-match@example.test' } });
  const input = compose('🔎 ', f.user(reviewer), ' 의견 부탁드립니다. ', outsider, '와 ', f.user(reviewer), ' 확인. ', f.user(writer));
  const request = { resourceType: 'issue', resourceId: issue.id, ...input, body: `  ${input.body}  ` };
  const created = await f.call<Comment>('/comments', { method: 'POST', body: request, status: 201 });
  assert.equal(created.body, input.body);
  assert.deepEqual(created.mentions, input.mentions);
  assert.deepEqual(await f.list('issue', issue.id), [created]);
  for (const actor of [reviewer, unassociated]) {
    const notices = await f.inbox(actor, issue.id);
    assert.deepEqual(notices.map(({ kind, commentId, actorId }) => ({ kind, commentId, actorId })), [
      { kind: 'issue-comment-mentioned', commentId: created.id, actorId: writer },
    ]);
    assert.ok(!JSON.stringify(notices).includes(input.body));
  }
  assert.deepEqual((await f.inbox(collaborator, issue.id)).map(({ kind, commentId }) => [kind, commentId]), [['issue-comment', created.id]]);
  for (const actor of [sameName.id, writer]) assert.deepEqual(await f.inbox(actor, issue.id), []);

  const docInput = compose(sameName, ' 문서 내용을 검토해 주세요.');
  const documentComment = await f.call<Comment>('/comments', { method: 'POST', status: 201,
    body: { resourceType: 'document', resourceId: document.id, ...docInput } });
  assert.deepEqual(documentComment.mentions, docInput.mentions);
  assert.deepEqual((await f.inbox(sameName.id, document.id)).map(item => [item.kind, item.commentId]), [
    ['document-comment-mentioned', documentComment.id],
  ]);
  assert.deepEqual(await f.inbox(unassociated, document.id), []);
  assert.deepEqual((await f.inbox(reviewer, document.id)).map(item => item.kind), ['document-comment']);

  const [first] = input.mentions;
  const invalid = [null, {}, [{ ...first, unexpected: true }], [{ ...first, from: 1 }], [{ ...first, to: first.to + 1 }],
    [{ ...first, userId: 'missing' }], [{ ...first, userId: unassociated }], [first, first],
    [...input.mentions].reverse(), Array.from({ length: MAX_COMMENT_MENTIONS + 1 }, () => first)];
  for (const mentions of invalid) await f.call('/comments', { method: 'POST', body: { ...request, mentions }, status: 400 });
  assert.deepEqual(await f.list('issue', issue.id), [created]);
  assert.equal((await f.inbox(reviewer, issue.id)).length, 1);
  const plain = await f.call<Comment>('/comments', { method: 'POST', body: { ...request, mentions: [] }, status: 201 });
  assert.equal(plain.mentions, undefined);
  assert.equal((await f.inbox(unassociated, issue.id)).length, 1);
  assert.deepEqual((await f.inbox(reviewer, issue.id)).map(item => item.kind), ['issue-comment', 'issue-comment-mentioned']);
});

test('a pinned comment saves mention alerts with its receipt and replays after a member is renamed', async t => {
  const f = await fixture(t);
  const document = await f.document('원문 문장 멘션');
  const path = `/documents/${document.id}/selection-comments`;
  const input = { requestId: randomUUID(), expectedDocumentVersion: document.version,
    sourceSelection: { from: 1, to: pinText.length + 1, text: pinText }, ...compose(f.user(reviewer), ' 이 문장을 확인해 주세요.') };

  const db = new DatabaseSync(join(f.directory, 'teamspace.sqlite'));
  try {
    db.prepare('DELETE FROM revisions WHERE document_id=?').run(document.id);
    db.exec(`CREATE TRIGGER fail_synthetic_mention BEFORE INSERT ON team_notifications WHEN new.kind='document-comment-mentioned'
      BEGIN SELECT RAISE(ABORT, 'synthetic comment mention notification failure'); END`);
    await f.call(path, { method: 'POST', body: input, status: 500 });
    assert.deepEqual(await f.list('document', document.id), []);
    assert.deepEqual(await f.inbox(reviewer, document.id), []);
    assert.deepEqual(await f.call<DocRevision[]>(`/documents/${document.id}/revisions`), []);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS fail_synthetic_mention');
    db.close();
  }
  const saved = await f.call<DocumentSelectionCommentResult>(path, { method: 'POST', body: input, status: 201 });
  assert.ok(saved.comment.documentSource?.revisionId);
  assert.deepEqual(saved.comment.mentions, input.mentions);
  await f.call(`/users/${reviewer}`, { method: 'PATCH', body: { name: '변경된 팀원 이름' } });
  assert.deepEqual(await f.call(path, { method: 'POST', body: input }), { duplicate: true, comment: saved.comment });
  const changed = await f.call<{ details: { reason: string } }>(path, { method: 'POST', body: { ...input, mentions: [] }, status: 409 });
  assert.equal(changed.details.reason, 'request_reused');
  await f.call(path, { method: 'POST', body: { ...input, requestId: randomUUID() }, status: 400 });
  assert.deepEqual((await f.inbox(reviewer, document.id)).map(item => [item.kind, item.commentId]), [
    ['document-comment-mentioned', saved.comment.id],
  ]);
  assert.deepEqual(await f.list('document', document.id), [saved.comment]);
});

test('native format 71 verifies live, trash and individual comment mentions and preserves historical names and notices', async t => {
  const f = await fixture(t);
  const issue = await f.issue('보존된 댓글 멘션');
  const document = await f.document('휴지통 문서의 댓글 멘션');
  const input = compose(f.user(unassociated), ' 확인했습니다.');
  const send = (resourceType: 'issue' | 'document', resourceId: string) =>
    f.call<Comment>('/comments', { method: 'POST', body: { resourceType, resourceId, ...input }, status: 201 });
  const live = await send('issue', issue.id);
  const inResourceTrash = await send('document', document.id);
  const inItemTrash = await send('document', document.id);
  const removed = await send('issue', issue.id);
  const read = (await f.inbox(unassociated, issue.id)).find(item => item.commentId === live.id)!;
  await f.call(`/notifications/${read.id}/read`, { method: 'PATCH', actor: unassociated, body: {} });
  const { trashItemId } = await f.call<{ trashItemId: string }>(`/comments/${inItemTrash.id}`, { method: 'DELETE' });
  const { trashEntryId } = await f.call<{ trashEntryId: string }>(`/documents/${document.id}`, { method: 'DELETE', body: { expectedVersion: document.version } });
  const deleted = await f.call<{ trashItemId: string }>(`/comments/${removed.id}`, { method: 'DELETE' });
  await f.call(`/trash/items/${deleted.trashItemId}`, { method: 'DELETE' });
  await f.call(`/users/${unassociated}`, { method: 'PATCH', body: { name: '새 표시 이름' } });
  const backup = await f.call<Backup>('/export');
  assert.ok(backup.schemaVersion >= 71);
  assert.match((await f.restore({ ...backup, schemaVersion: 70 }, 400)).error!, /schemaVersion 71/);
  const entries = (data: Backup) => [data.comments.find(value => value.id === live.id)!,
    data.trashEntries.find(value => value.id === trashEntryId)!.comments.find(value => value.id === inResourceTrash.id)!,
    data.trashItems.find(value => value.id === trashItemId)!.item];
  for (const index of [0, 1, 2]) {
    const corrupt = structuredClone(backup);
    entries(corrupt)[index].mentions![0].userId = 'unavailable';
    await f.restore(corrupt, 400);
  }
  const wrongAlert = structuredClone(backup);
  wrongAlert.teamNotifications.find(item => item.id === read.id)!.commentId = inResourceTrash.id;
  await f.restore(wrongAlert, 400);
  const missingCommentId = structuredClone(backup);
  delete missingCommentId.teamNotifications.find(item => item.id === read.id)!.commentId;
  await f.restore(missingCommentId, 400);
  assert.deepEqual(await f.list('issue', issue.id), [live]);

  const old = structuredClone(backup);
  old.schemaVersion = 70;
  for (const item of old.teamNotifications) if (item.kind === 'issue-comment') delete item.commentId;
  for (const comment of entries(old)) delete comment.mentions;
  assert.match((await f.restore(old, 400)).error!, /schemaVersion 71/);
  old.teamNotifications = old.teamNotifications.filter(item => !mentionKinds.has(item.kind));
  await f.restore(old);
  assert.equal((await f.list('issue', issue.id))[0].mentions, undefined);

  await f.restore(backup);
  assert.deepEqual(await f.list('issue', issue.id), [live]);
  await f.call(`/trash/${trashEntryId}/restore`, { method: 'POST', body: {} });
  await f.call(`/trash/items/${trashItemId}/restore`, { method: 'POST', body: {} });
  assert.deepEqual(await f.list('document', document.id), [inResourceTrash, inItemTrash]);
  const restoredNotifications = (await f.call<Backup>('/export')).teamNotifications;
  assert.deepEqual(restoredNotifications, backup.teamNotifications);
  assert.ok(restoredNotifications.find(item => item.commentId === removed.id));
  assert.ok(restoredNotifications.find(item => item.id === read.id)?.readAt);
});
