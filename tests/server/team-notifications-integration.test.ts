import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type {
  ApiKeyCreated, Comment, DocPage, DocumentPublicationView, Issue, LegacyPackageSummary, MigrationOptions,
  MigrationPreview, TeamNotification, TeamNotificationPage, WorkspaceSnapshot,
} from '../../shared/types.js';

const editor = 'user-min';
const reviewer = 'user-seo';
const collaborator = 'user-jun';
const other = 'user-yun';
const privateComment = '내용이 알림에 포함되면 안 되는 댓글';
const privateNote = '내용이 알림에 포함되면 안 되는 검토 메모';
type Backup = WorkspaceSnapshot & { schemaVersion: number; teamNotifications: TeamNotification[] };

async function open(dataDir: string) {
  const app = createApp({ dataDir, outboundWorker: false });
  const server = app.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  return {
    base,
    async call<T = unknown>(path: string, method = 'GET', body?: unknown, actorId: string | null = editor) {
      const headers = new Headers({ 'Content-Type': 'application/json' });
      if (actorId) headers.set('X-Actor-Id', actorId);
      const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, data: await response.json() as T };
    },
    async close() {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      app.close();
    },
  };
}

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-team-notifications-'));
  let runtime: Awaited<ReturnType<typeof open>> | undefined;
  t.after(async () => {
    await runtime?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  runtime = await open(dataDir);
  const call: Awaited<ReturnType<typeof open>>['call'] = (path, method, body, actorId) => runtime!.call(path, method, body, actorId);
  return {
    call,
    get base() { return runtime!.base; },
    async restart() {
      await runtime!.close();
      runtime = undefined;
      runtime = await open(dataDir);
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function expectStatus<T>(request: Promise<{ status: number; data: T }>, status = 200) {
  const result = await request;
  assert.equal(result.status, status, JSON.stringify(result.data));
  return result.data;
}

async function inbox(f: Fixture, actorId: string, query = '') {
  return expectStatus(f.call<TeamNotificationPage>('/notifications' + query, 'GET', undefined, actorId));
}

async function issue(f: Fixture, assigneeId: string, title: string, collaboratorIds: string[] = []) {
  return expectStatus(f.call<Issue>('/issues', 'POST', { projectId: 'project-neo', title, assigneeId, collaboratorIds }), 201);
}

async function comment(f: Fixture, resourceType: 'issue' | 'document', resourceId: string, actorId: string) {
  return expectStatus(f.call('/comments', 'POST', { resourceType, resourceId, body: privateComment }, actorId), 201);
}

function event(item: TeamNotification) {
  const { kind, recipientId, actorId, projectId, targetId, targetLabel } = item;
  return { kind, recipientId, actorId, projectId, targetId, targetLabel };
}

test('issue assignment and comments notify their committed recipients without duplicates or self notifications', async t => {
  const f = await fixture(t);
  const created = await issue(f, reviewer, '팀 알림 티켓', [reviewer, collaborator, reviewer, editor]);
  const target = { projectId: created.projectId, targetId: created.id, targetLabel: `${created.key} ${created.title}` };
  const assignment = (recipientId: string) => ({ ...target, actorId: editor, recipientId, kind: 'issue-assigned' });
  const issueComment = (recipientId: string, actorId: string) => ({ ...target, actorId, recipientId, kind: 'issue-comment' });
  assert.deepEqual((await inbox(f, reviewer)).items.map(event), [assignment(reviewer)]);
  assert.equal((await inbox(f, collaborator)).unreadCount, 0);
  await issue(f, editor, '내가 담당하는 티켓');
  assert.equal((await inbox(f, editor)).unreadCount, 0);

  const patch = (version: number, assigneeId: string) => f.call<Issue>(`/issues/${created.id}`, 'PATCH', {
    expectedVersion: version, assigneeId,
  });
  const unchanged = await expectStatus(patch(created.version, reviewer));
  assert.equal((await inbox(f, reviewer)).unreadCount, 1);
  await expectStatus(patch(unchanged.version, collaborator));
  await expectStatus(patch(unchanged.version, other), 409);
  assert.deepEqual((await inbox(f, collaborator)).items.map(event), [assignment(collaborator)]);
  assert.equal((await inbox(f, other)).unreadCount, 0);

  await comment(f, 'issue', created.id, editor);
  await comment(f, 'issue', created.id, collaborator);
  const assignee = await inbox(f, collaborator);
  assert.deepEqual(assignee.items.map(event), [issueComment(collaborator, editor), assignment(collaborator)]);
  const teammate = await inbox(f, reviewer);
  assert.deepEqual(teammate.items.map(event), [issueComment(reviewer, collaborator), issueComment(reviewer, editor), assignment(reviewer)]);
  assert.ok(teammate.items.every(item => item.readAt === null && Number.isFinite(Date.parse(item.createdAt))));
  assert.equal(JSON.stringify(teammate).includes(privateComment), false);
});

test('public writes notify under the API key owner while recipient inbox access stays on the browser API', async t => {
  const f = await fixture(t);
  const { token } = await expectStatus(f.call<ApiKeyCreated>('/api-keys', 'POST', {
    name: '합성 알림 자동화 키', access: 'write', projectIds: ['project-neo'],
  }), 201);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Actor-Id': other };
  const response = await fetch(f.base + '/v1/issues', {
    method: 'POST', headers, body: JSON.stringify({ projectId: 'project-neo', title: '자동화 티켓', assigneeId: reviewer }),
  });
  const created = await response.json() as Issue;
  assert.equal(response.status, 201, JSON.stringify(created));
  const page = await inbox(f, reviewer);
  assert.deepEqual(page.items.map(item => [item.targetId, item.actorId]), [[created.id, editor]]);

  const disabled = await fetch(f.base + '/v1/notifications', { headers });
  assert.equal(disabled.status, 403);
  await disabled.text();
});

test('document comment and review transitions notify the original author, designated reviewer, or requester as appropriate', async t => {
  const f = await fixture(t);
  const document = await expectStatus(f.call<DocPage>('/documents', 'POST', { title: '공통 문서 검토 알림' }), 201);
  const publicationPath = `/documents/${document.id}/publication`;
  const initial = await expectStatus(f.call<DocumentPublicationView>(publicationPath));
  const transition = (before: DocumentPublicationView, action: string, actorId: string, review?: { expectedDocumentVersion: number; reviewerId: string }) =>
    f.call<DocumentPublicationView>(publicationPath, 'POST', {
      action, expectedVersion: before.version, workspaceGeneration: before.workspaceGeneration, note: privateNote, ...review,
    }, actorId);
  const request = { expectedDocumentVersion: document.version, reviewerId: reviewer };

  await comment(f, 'document', document.id, reviewer);
  await comment(f, 'document', document.id, editor);
  const requested = await expectStatus(transition(initial, 'request', collaborator, request));
  await expectStatus(transition(requested, 'publish', other), 403);
  const feedback = await expectStatus(transition(requested, 'request_changes', reviewer));
  await expectStatus(transition(requested, 'request_changes', reviewer), 409);
  const requestedAgain = await expectStatus(transition(feedback, 'request', collaborator, request));
  const published = await expectStatus(transition(requestedAgain, 'publish', reviewer));
  const edited = await expectStatus(f.call<DocPage>(`/documents/${document.id}`, 'PATCH', {
    title: '철회하려는 새 초안', expectedVersion: document.version,
  }));
  const latestRequest = await expectStatus(transition(published, 'request', collaborator, { ...request, expectedDocumentVersion: edited.version }));
  await expectStatus(transition(latestRequest, 'withdraw', collaborator));

  const details = { projectId: null, targetId: document.id, targetLabel: document.title };
  const requestedEvent = { ...details, recipientId: reviewer, actorId: collaborator, kind: 'document-review-requested' };
  const authorInbox = await inbox(f, editor);
  assert.deepEqual(authorInbox.items.map(event), [{ ...details, recipientId: editor, actorId: reviewer, kind: 'document-comment' }]);
  const requesterInbox = await inbox(f, collaborator);
  assert.deepEqual(requesterInbox.items.map(event), [
    { ...details, recipientId: collaborator, actorId: reviewer, kind: 'document-published' },
    { ...details, recipientId: collaborator, actorId: reviewer, kind: 'document-changes-requested' },
  ]);
  const reviewerInbox = await inbox(f, reviewer);
  assert.deepEqual(reviewerInbox.items.map(event), [
    { ...requestedEvent, kind: 'document-review-withdrawn', targetLabel: edited.title },
    { ...requestedEvent, targetLabel: edited.title }, requestedEvent, requestedEvent,
  ]);
  assert.equal((await inbox(f, other)).unreadCount, 0);
  assert.equal(JSON.stringify([authorInbox, requesterInbox, reviewerInbox]).includes(privateNote), false);
});

test('recipient-scoped pagination and read actions keep newer notifications unread', async t => {
  const f = await fixture(t);
  const read = (id: string, actorId: string) => f.call<{ unreadCount: number }>(`/notifications/${id}/read`, 'PATCH', undefined, actorId);
  const readAll = (throughId: string, actorId: string) => f.call<{ unreadCount: number }>('/notifications/read-all', 'PATCH', { throughId }, actorId);
  const count = (actorId: string | null) => f.call<{ unreadCount: number }>('/notifications/count', 'GET', undefined, actorId);
  await expectStatus(count(null), 400);
  await expectStatus(count('unknown-actor'), 400);
  await expectStatus(f.call('/notifications?filter=all&filter=unread'), 400);
  await expectStatus(f.call('/notifications?filter=invalid'), 400);
  await expectStatus(f.call('/notifications', 'GET', undefined, null), 400);

  const first = await issue(f, reviewer, '가장 오래된 알림');
  for (let index = 1; index <= 50; index++) await comment(f, 'issue', first.id, editor);
  const firstPage = await inbox(f, reviewer);
  assert.equal(firstPage.items.length, 50);
  assert.equal(firstPage.unreadCount, 51);
  assert.ok(firstPage.nextCursor);
  const before = `?before=${encodeURIComponent(firstPage.nextCursor)}`;
  await expectStatus(f.call('/notifications' + before, 'GET', undefined, collaborator), 400);
  const fresh = await issue(f, reviewer, '페이지를 확인한 후 들어온 알림');
  const secondPage = await inbox(f, reviewer, before);
  assert.equal(secondPage.nextCursor, null);
  assert.equal(secondPage.items.length, 1);
  const [firstNotification] = secondPage.items;
  assert.equal(firstNotification.targetId, first.id);
  assert.equal(firstNotification.kind, 'issue-assigned');
  assert.ok(firstPage.items.every(item => item.id !== firstNotification.id));

  await expectStatus(read(firstNotification.id, collaborator), 404);
  await expectStatus(readAll(firstPage.items[0].id, collaborator), 404);
  assert.deepEqual(await expectStatus(read(firstNotification.id, reviewer)), { unreadCount: 51 });
  const originalReadAt = (await inbox(f, reviewer, before)).items[0].readAt;
  assert.ok(originalReadAt);
  assert.deepEqual(await expectStatus(read(firstNotification.id, reviewer)), { unreadCount: 51 });
  assert.equal((await inbox(f, reviewer, before)).items[0].readAt, originalReadAt);
  assert.deepEqual(await expectStatus(readAll(firstPage.items[0].id, reviewer)), { unreadCount: 1 });
  assert.deepEqual(await expectStatus(count(reviewer)), { unreadCount: 1 });
  assert.deepEqual(await expectStatus(count(collaborator)), { unreadCount: 0 });
  const unread = await inbox(f, reviewer, '?filter=unread');
  assert.deepEqual(unread.items.map(item => item.targetId), [fresh.id]);
  assert.equal(unread.nextCursor, null);
});

test('notification history and read state survive restart and schema 15 restore, and schema 14 starts empty', async t => {
  const f = await fixture(t);
  const received = await issue(f, reviewer, '백업할 알림');
  const start = await inbox(f, reviewer);
  await expectStatus(f.call(`/notifications/${start.items[0].id}/read`, 'PATCH', undefined, reviewer));
  const saved = await inbox(f, reviewer);
  assert.ok(saved.items[0].readAt);
  const backup = await expectStatus(f.call<Backup>('/export'));
  assert.equal(backup.schemaVersion, 16);
  assert.deepEqual(backup.teamNotifications, saved.items);
  await f.restart();
  assert.deepEqual(await inbox(f, reviewer), saved);
  await issue(f, reviewer, '백업 뒤 받은 알림');
  const beforeInvalid = await inbox(f, reviewer);
  const invalid = structuredClone(backup);
  invalid.teamNotifications[0].recipientId = 'missing-team-member';
  await expectStatus(f.call('/import', 'POST', { data: invalid }), 400);
  assert.deepEqual(await inbox(f, reviewer), beforeInvalid);
  await expectStatus(f.call('/import', 'POST', { data: backup }));
  assert.deepEqual(await inbox(f, reviewer), saved);
  const old: Partial<Backup> = { ...backup, schemaVersion: 14 };
  delete old.teamNotifications;
  await expectStatus(f.call('/import', 'POST', { data: old }));
  assert.deepEqual(await inbox(f, reviewer), { items: [], nextCursor: null, unreadCount: 0 });
  assert.ok((await expectStatus(f.call<WorkspaceSnapshot>('/workspace'))).issues.some(value => value.id === received.id));
});

test('Jira imports with mapped assignees and comments preserve the inbox without creating live notifications', async t => {
  const f = await fixture(t);
  await issue(f, reviewer, '이미 받은 알림');
  const before = await inbox(f, reviewer);
  const params = new URLSearchParams({ filename: 'notifications.csv', product: 'jira', instanceKey: 'synthetic-notifications' });
  const csv = [
    'Issue id,Issue key,Project key,Summary,Reporter,Assignee,Created,Updated,Status,Issue Type,Comment',
    '123,NOTIF-1,NOTIF,이관한 티켓,old.reporter,old.assignee,2020-01-01T00:00:00Z,2020-01-02T00:00:00Z,Open,Task,"2020-01-02T00:00:00Z;old.reporter;이관한 댓글"',
  ].join('\r\n');
  const uploaded = await fetch(`${f.base}/legacy-import/packages?${params}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': editor }, body: Buffer.from(csv),
  });
  const source = await uploaded.json() as LegacyPackageSummary;
  assert.equal(uploaded.status, 201, JSON.stringify(source));
  const options = await expectStatus(f.call<MigrationOptions>(`/migrations/options?packageId=${source.id}`));
  const configuration = options.defaultConfiguration;
  for (const identity of options.identities) configuration.users[identity.id] = identity.sourceValue === 'old.assignee' ? reviewer : editor;
  configuration.datePolicy = 'import-time';
  const preview = await expectStatus(f.call<MigrationPreview>('/migrations/preview', 'POST', { configuration }), 201);
  assert.equal(preview.canApply, true, JSON.stringify(preview.notices));
  await expectStatus(f.call(`/migrations/previews/${preview.id}/apply`, 'POST', {
    expectedVersion: preview.version, acknowledgements: preview.requiredAcknowledgements,
  }), 201);
  const imported = (await expectStatus(f.call<WorkspaceSnapshot>('/workspace'))).issues.find(value => value.title === '이관한 티켓');
  assert.ok(imported);
  assert.equal(imported.assigneeId, reviewer);
  const comments = await expectStatus(f.call<Comment[]>(`/comments?resourceType=issue&resourceId=${imported.id}`));
  assert.deepEqual(comments.map(value => [value.authorId, value.body]), [[editor, '이관한 댓글']]);
  assert.deepEqual(await inbox(f, reviewer), before);
  assert.equal((await inbox(f, editor)).unreadCount, 0);
});
