import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import { ISSUE_RISK_NOTIFICATION_KINDS } from '../../shared/types.js';
import type {
  ApiKeyCreated, Comment, DocPage, DocumentPublicationView, Issue, IssueRelation, LegacyPackageSummary, MigrationOptions,
  MigrationPreview, NotificationSubscription, NotificationSubscriptionState, NotificationSubscriptionTarget,
  TeamNotification, TeamNotificationPage, WorkspaceSnapshot,
} from '../../shared/types.js';

const editor = 'user-min';
const reviewer = 'user-seo';
const collaborator = 'user-jun';
const other = 'user-yun';
const privateComment = '내용이 알림에 포함되면 안 되는 댓글';
const privateNote = '내용이 알림에 포함되면 안 되는 검토 메모';
type Backup = WorkspaceSnapshot & { schemaVersion: number; teamNotifications: TeamNotification[]; notificationSubscriptions: NotificationSubscription[] };
const subscriptionPath = (targetType: NotificationSubscriptionTarget, targetId: string) => `/notifications/subscriptions/${targetType}/${encodeURIComponent(targetId)}`;

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
    async restart(whileOffline?: (dataDir: string) => void) {
      await runtime!.close();
      runtime = undefined;
      whileOffline?.(dataDir);
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

async function checkSubscription(f: Fixture, path: string, actorId: string, subscribed?: boolean) {
  return expectStatus(f.call<NotificationSubscriptionState>(path, subscribed === undefined ? 'GET' : 'PUT',
    subscribed === undefined ? undefined : { subscribed }, actorId));
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

const riskKinds: ReadonlySet<TeamNotification['kind']> = new Set(ISSUE_RISK_NOTIFICATION_KINDS);
const isRiskNotification = (item: TeamNotification) => riskKinds.has(item.kind);
const riskInbox = async (f: Fixture, actorId: string, query = '') =>
  (await inbox(f, actorId, query)).items.filter(isRiskNotification);

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
  const projectWatchPath = subscriptionPath('project', 'project-neo');
  await checkSubscription(f, projectWatchPath, collaborator, true);
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
  assert.deepEqual((await inbox(f, collaborator)).items.map(item => [item.targetId, item.kind, item.actorId]), [[created.id, 'issue-created', editor]]);

  const disabled = await fetch(f.base + '/v1/notifications', { headers });
  assert.equal(disabled.status, 403);
  await disabled.text();
  for (const path of [subscriptionPath('issue', created.id), projectWatchPath, subscriptionPath('space', 'common')]) {
    for (const method of ['GET', 'PUT']) {
      const response = await fetch(f.base + '/v1' + path, { method, headers, body: method === 'PUT' ? '{"subscribed":true}' : undefined });
      assert.equal(response.status, 403);
      await response.text();
    }
  }
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
  const watchPath = subscriptionPath('document', document.id);
  await checkSubscription(f, watchPath, collaborator, true);
  await checkSubscription(f, watchPath, other, true);
  const published = await expectStatus(transition(requestedAgain, 'publish', reviewer));
  await checkSubscription(f, watchPath, collaborator, false);
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
  assert.deepEqual((await inbox(f, other)).items.map(event), [
    { ...details, recipientId: other, actorId: editor, kind: 'document-updated', targetLabel: edited.title },
    { ...details, recipientId: other, actorId: reviewer, kind: 'document-published' },
  ]);
  assert.equal(JSON.stringify([authorInbox, requesterInbox, reviewerInbox]).includes(privateNote), false);
});

test('individual ticket subscriptions are idempotent and deliver committed comments and status changes', async t => {
  const f = await fixture(t);
  const ticket = await issue(f, reviewer, '구독하는 업무');
  const path = subscriptionPath('issue', ticket.id);
  await expectStatus(f.call(path, 'GET', undefined, null), 400);
  await expectStatus(f.call(path + '?userId=user-min', 'GET', undefined, reviewer), 400);
  await expectStatus(f.call(path, 'PUT', { subscribed: true, userId: other }, reviewer), 400);
  assert.deepEqual(await checkSubscription(f, path, other), { subscribed: false });
  assert.deepEqual(await checkSubscription(f, path, reviewer, true), { subscribed: true });
  assert.deepEqual(await checkSubscription(f, path, reviewer, true), { subscribed: true });
  assert.deepEqual(await checkSubscription(f, path, other), { subscribed: false });
  await checkSubscription(f, path, other, true);
  await comment(f, 'issue', ticket.id, editor);

  const patch = (expectedVersion: number, status: string, actorId: string | null, extra: object = {}) =>
    f.call<Issue>(`/issues/${ticket.id}`, 'PATCH', { expectedVersion, status, ...extra }, actorId);
  const changed = await expectStatus(patch(ticket.version, 'in_progress', editor));
  await expectStatus(patch(ticket.version, 'todo', editor), 409);
  await expectStatus(patch(changed.version, 'todo', null, { actorId: 'missing-team-member' }), 400);
  const unchanged = await expectStatus(patch(changed.version, 'in_progress', editor));
  assert.deepEqual((await inbox(f, reviewer)).items.map(item => item.kind), ['issue-status-changed', 'issue-comment', 'issue-assigned']);
  assert.deepEqual((await inbox(f, other)).items.map(item => item.kind), ['issue-status-changed', 'issue-comment']);
  assert.ok((await inbox(f, other)).items.every(item => item.targetId === ticket.id && item.actorId === editor));
  await checkSubscription(f, path, other, false);
  await expectStatus(patch(unchanged.version, 'todo', reviewer));
  assert.equal((await inbox(f, other)).unreadCount, 2);
  assert.equal((await inbox(f, reviewer)).unreadCount, 3);
});

test('project subscriptions cover new issues, status changes and comments only in the selected project', async t => {
  const f = await fixture(t);
  await issue(f, editor, '구독 시작 전에 등록한 업무');
  const projectPath = subscriptionPath('project', 'project-neo');
  const otherProjectPath = subscriptionPath('project', 'project-team');
  const missingProjectPath = subscriptionPath('project', 'missing-project');
  await expectStatus(f.call(missingProjectPath, 'GET', undefined, reviewer), 404);
  await expectStatus(f.call(missingProjectPath, 'PUT', { subscribed: true }, reviewer), 404);
  assert.deepEqual(await checkSubscription(f, projectPath, reviewer), { subscribed: false });
  for (const watcher of [reviewer, editor]) await checkSubscription(f, projectPath, watcher, true);
  assert.deepEqual(await checkSubscription(f, projectPath, reviewer, true), { subscribed: true });
  assert.equal((await inbox(f, reviewer)).unreadCount, 0);
  await checkSubscription(f, otherProjectPath, other, true);
  assert.deepEqual(await checkSubscription(f, projectPath, other), { subscribed: false });

  const ticket = await issue(f, editor, '프로젝트에 새로 등록한 업무', [collaborator]);
  const assigned = await issue(f, reviewer, '프로젝트 구독자가 담당하는 업무');
  const otherTicket = await expectStatus(f.call<Issue>('/issues', 'POST', { projectId: 'project-team', title: '다른 프로젝트의 새 업무' }), 201);
  assert.deepEqual((await inbox(f, reviewer)).items.map(item => [item.targetId, item.kind]), [
    [assigned.id, 'issue-assigned'],
    [ticket.id, 'issue-created'],
  ]);
  const otherInbox = await inbox(f, other);
  assert.deepEqual(otherInbox.items.map(item => [item.targetId, item.projectId, item.kind]), [[otherTicket.id, 'project-team', 'issue-created']]);
  assert.equal((await inbox(f, editor)).unreadCount, 0);
  assert.equal((await inbox(f, collaborator)).unreadCount, 0);

  const watchTicket = subscriptionPath('issue', ticket.id);
  for (const watcher of [reviewer, collaborator]) await checkSubscription(f, watchTicket, watcher, true);
  const changed = await expectStatus(f.call<Issue>(`/issues/${ticket.id}`, 'PATCH', { expectedVersion: ticket.version, status: 'in_progress' }));
  await expectStatus(f.call(`/issues/${ticket.id}`, 'PATCH', { expectedVersion: ticket.version, status: 'todo' }), 409);
  await expectStatus(f.call(`/issues/${ticket.id}`, 'PATCH', { expectedVersion: changed.version, status: 'in_progress' }));
  await comment(f, 'issue', ticket.id, editor);
  const receivedKinds = async (watcher: string) => (await inbox(f, watcher)).items.filter(item => item.targetId === ticket.id).map(item => item.kind);
  assert.deepEqual(await receivedKinds(reviewer), ['issue-comment', 'issue-status-changed', 'issue-created']);
  assert.deepEqual(await receivedKinds(collaborator), ['issue-comment', 'issue-status-changed']);
  assert.deepEqual(await inbox(f, other), otherInbox);
  assert.equal((await inbox(f, editor)).unreadCount, 0);

  await checkSubscription(f, projectPath, reviewer, false);
  const later = await issue(f, editor, '프로젝트 구독을 해제한 뒤 만든 업무');
  assert.equal((await inbox(f, reviewer)).items.some(item => item.targetId === later.id), false);
  await comment(f, 'issue', ticket.id, editor);
  assert.deepEqual(await receivedKinds(reviewer), ['issue-comment', 'issue-comment', 'issue-status-changed', 'issue-created']);
  await checkSubscription(f, watchTicket, reviewer, false);
  const before = await inbox(f, reviewer);
  await comment(f, 'issue', ticket.id, editor);
  assert.deepEqual(await inbox(f, reviewer), before);
});

test('document spaces deliver creation, edit, comment and publication with independent project and common subscriptions', async t => {
  const f = await fixture(t);
  const newDocument = (title: string, projectId: string | null) =>
    expectStatus(f.call<DocPage>('/documents', 'POST', { title, projectId }), 201);
  await newDocument('구독 시작 전에 등록한 공통 문서', null);
  const projectSpace = subscriptionPath('space', 'project:project-neo');
  const otherSpace = subscriptionPath('space', 'project:project-team');
  const commonSpace = subscriptionPath('space', 'common');
  await expectStatus(f.call(subscriptionPath('space', 'project:'), 'GET', undefined, reviewer), 400);
  await expectStatus(f.call(subscriptionPath('space', 'project-neo'), 'GET', undefined, reviewer), 400);
  await expectStatus(f.call(subscriptionPath('space', 'project:missing-project'), 'GET', undefined, reviewer), 404);
  await expectStatus(f.call(`/notifications/subscriptions/unknown/common`, 'GET', undefined, reviewer), 400);
  await checkSubscription(f, projectSpace, reviewer, true);
  await checkSubscription(f, projectSpace, editor, true);
  await checkSubscription(f, otherSpace, collaborator, true);
  await checkSubscription(f, commonSpace, other, true);
  await checkSubscription(f, commonSpace, editor, true);
  await checkSubscription(f, subscriptionPath('project', 'project-team'), reviewer, true);
  assert.deepEqual(await checkSubscription(f, commonSpace, reviewer), { subscribed: false });
  assert.equal((await inbox(f, other)).unreadCount, 0);

  const projectDoc = await newDocument('프로젝트 공간의 새 문서', 'project-neo');
  const commonDoc = await newDocument('공통 공간의 새 문서', null);
  const otherDoc = await newDocument('다른 프로젝트 공간의 새 문서', 'project-team');
  const received = async (watcher: string) => (await inbox(f, watcher)).items.map(item => [item.targetId, item.projectId, item.kind]);
  assert.deepEqual(await received(reviewer), [[projectDoc.id, 'project-neo', 'document-created']]);
  assert.deepEqual(await received(other), [[commonDoc.id, null, 'document-created']]);
  assert.deepEqual(await received(collaborator), [[otherDoc.id, 'project-team', 'document-created']]);
  assert.equal((await inbox(f, editor)).unreadCount, 0);

  async function updateCommentAndPublish(doc: DocPage, watcher: string) {
    await checkSubscription(f, subscriptionPath('document', doc.id), watcher, true);
    const updated = await expectStatus(f.call<DocPage>(`/documents/${doc.id}`, 'PATCH', { expectedVersion: doc.version, title: `${doc.title} 수정` }));
    await comment(f, 'document', doc.id, editor);
    const path = `/documents/${doc.id}/publication`;
    const initial = await expectStatus(f.call<DocumentPublicationView>(path));
    const requested = await expectStatus(f.call<DocumentPublicationView>(path, 'POST', {
      action: 'request', expectedVersion: initial.version, workspaceGeneration: initial.workspaceGeneration,
      expectedDocumentVersion: updated.version, reviewerId: collaborator,
    }));
    await expectStatus(f.call(path, 'POST', { action: 'publish', expectedVersion: requested.version, workspaceGeneration: requested.workspaceGeneration }, collaborator));
    return updated;
  }

  const editedProject = await updateCommentAndPublish(projectDoc, reviewer);
  await updateCommentAndPublish(commonDoc, other);
  const kinds = ['document-published', 'document-comment', 'document-updated', 'document-created'];
  assert.deepEqual(await received(reviewer), kinds.map(kind => [projectDoc.id, 'project-neo', kind]));
  assert.deepEqual(await received(other), kinds.map(kind => [commonDoc.id, null, kind]));
  assert.equal(JSON.stringify(await inbox(f, other)).includes(privateComment), false);

  await checkSubscription(f, subscriptionPath('document', projectDoc.id), reviewer, false);
  await expectStatus(f.call(`/documents/${projectDoc.id}`, 'PATCH', { expectedVersion: editedProject.version, projectId: 'project-team' }));
  assert.deepEqual(await received(reviewer), kinds.map(kind => [projectDoc.id, 'project-neo', kind]));
  assert.deepEqual((await received(collaborator))[0], [projectDoc.id, 'project-team', 'document-updated']);

  await checkSubscription(f, commonSpace, other, false);
  await newDocument('공통 공간 구독을 해제한 뒤 만든 문서', null);
  await comment(f, 'document', commonDoc.id, editor);
  assert.deepEqual(await received(other), ['document-comment', ...kinds].map(kind => [commonDoc.id, null, kind]));
});

test('individual subscriptions survive restart, trash and native backup; invalid replacements roll back', async t => {
  const f = await fixture(t);
  const ticket = await issue(f, editor, '휴지통 구독 업무');
  const document = await expectStatus(f.call<DocPage>('/documents', 'POST', { title: '복원할 구독 문서' }), 201);
  const issuePath = subscriptionPath('issue', ticket.id), documentPath = subscriptionPath('document', document.id);
  await checkSubscription(f, issuePath, other, true);
  await checkSubscription(f, documentPath, reviewer, true);
  const archived = await expectStatus(f.call<{ trashEntryId: string }>(`/issues/${ticket.id}`, 'DELETE'));
  await expectStatus(f.call(issuePath, 'GET', undefined, other), 404);
  const backup = await expectStatus(f.call<Backup>('/export'));
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.deepEqual(backup.notificationSubscriptions, [
    { userId: reviewer, targetType: 'document', targetId: document.id },
    { userId: other, targetType: 'issue', targetId: ticket.id },
  ]);
  await f.restart();
  assert.deepEqual(await checkSubscription(f, documentPath, reviewer), { subscribed: true });
  await checkSubscription(f, documentPath, other, true);
  const duplicates = [...backup.notificationSubscriptions, backup.notificationSubscriptions[0]];
  for (const invalid of [undefined, duplicates, [{ ...backup.notificationSubscriptions[0], targetId: 'missing-document' }]]) {
    await expectStatus(f.call('/import', 'POST', { data: { ...backup, notificationSubscriptions: invalid } }), 400);
    assert.deepEqual(await checkSubscription(f, documentPath, other), { subscribed: true });
  }
  await expectStatus(f.call('/import', 'POST', { data: { ...backup, schemaVersion: 24 } }), 400);
  await expectStatus(f.call('/import', 'POST', { data: backup }));
  assert.deepEqual(await checkSubscription(f, documentPath, other), { subscribed: false });
  await expectStatus(f.call(`/trash/${archived.trashEntryId}/restore`, 'POST'));
  assert.deepEqual(await checkSubscription(f, issuePath, other), { subscribed: true });
  assert.equal((await inbox(f, other)).unreadCount, 0);
  const deletedAgain = await expectStatus(f.call<{ trashEntryId: string }>(`/issues/${ticket.id}`, 'DELETE'));
  await expectStatus(f.call(`/trash/${deletedAgain.trashEntryId}`, 'DELETE'));
  const afterPurge = await expectStatus(f.call<Backup>('/export'));
  assert.deepEqual(afterPurge.notificationSubscriptions, backup.notificationSubscriptions.slice(0, 1));

  const old: Partial<Backup> = { ...afterPurge, schemaVersion: 24 };
  delete old.notificationSubscriptions;
  await expectStatus(f.call('/import', 'POST', { data: old }));
  assert.deepEqual(await checkSubscription(f, documentPath, reviewer), { subscribed: false });
});

test('native backup restores scope subscriptions and their events while older backups retain individual subscriptions', async t => {
  const f = await fixture(t);
  const original = await issue(f, editor, '범위 구독 백업 이전의 업무');
  const originalTicket = subscriptionPath('issue', original.id);
  await checkSubscription(f, originalTicket, other, true);
  const previous = { ...await expectStatus(f.call<Backup>('/export')), schemaVersion: 28 };
  const projectPath = subscriptionPath('project', 'project-neo');
  const commonPath = subscriptionPath('space', 'common');
  const projectSpacePath = subscriptionPath('space', 'project:project-neo');
  await checkSubscription(f, projectPath, reviewer, true);
  await checkSubscription(f, commonPath, collaborator, true);
  await checkSubscription(f, projectSpacePath, other, true);
  const created = await issue(f, editor, '구독으로 알림을 받은 새 업무');
  const common = await expectStatus(f.call<DocPage>('/documents', 'POST', { title: '구독으로 알림을 받은 공통 문서' }), 201);
  const oldInbox = await inbox(f, reviewer);
  const projectEvent = oldInbox.items.find(item => item.targetId === created.id);
  assert.equal(projectEvent?.kind, 'issue-created');
  const commonEvent = (await inbox(f, collaborator)).items.find(item => item.targetId === common.id);
  assert.equal(commonEvent?.kind, 'document-created');
  const backup = await expectStatus(f.call<Backup>('/export'));
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.deepEqual(backup.notificationSubscriptions, [
    { userId: other, targetType: 'issue', targetId: original.id },
    { userId: reviewer, targetType: 'project', targetId: 'project-neo' },
    { userId: collaborator, targetType: 'space', targetId: 'common' },
    { userId: other, targetType: 'space', targetId: 'project:project-neo' },
  ]);

  await f.restart();
  await expectStatus(f.call('/import', 'POST', { data: { ...previous, notificationSubscriptions: backup.notificationSubscriptions } }), 400);
  await expectStatus(f.call('/import', 'POST', { data: { ...previous, teamNotifications: backup.teamNotifications } }), 400);
  for (const invalid of [
    { userId: reviewer, targetType: 'project', targetId: 'missing-project' },
    { userId: reviewer, targetType: 'space', targetId: 'project-neo' },
    { userId: reviewer, targetType: 'space', targetId: 'project:missing-project' },
    { userId: reviewer, targetType: 'unknown', targetId: 'common' },
  ]) {
    await expectStatus(f.call('/import', 'POST', { data: { ...backup, notificationSubscriptions: [invalid] } }), 400);
  }
  assert.deepEqual(await inbox(f, reviewer), oldInbox);
  assert.deepEqual((await expectStatus(f.call<Backup>('/export'))).notificationSubscriptions, backup.notificationSubscriptions);

  await checkSubscription(f, projectPath, reviewer, false);
  await checkSubscription(f, commonPath, collaborator, false);
  await checkSubscription(f, projectSpacePath, other, false);
  await expectStatus(f.call('/import', 'POST', { data: backup }));
  assert.deepEqual(await checkSubscription(f, projectPath, reviewer), { subscribed: true });
  assert.deepEqual(await checkSubscription(f, commonPath, collaborator), { subscribed: true });
  assert.deepEqual(await checkSubscription(f, projectSpacePath, other), { subscribed: true });
  assert.deepEqual((await inbox(f, reviewer)).items, [projectEvent]);
  assert.deepEqual((await inbox(f, collaborator)).items, [commonEvent]);

  await expectStatus(f.call('/import', 'POST', { data: previous }));
  assert.deepEqual(await checkSubscription(f, originalTicket, other), { subscribed: true });
  assert.deepEqual(await checkSubscription(f, projectPath, reviewer), { subscribed: false });
  assert.deepEqual(await checkSubscription(f, commonPath, collaborator), { subscribed: false });
  assert.deepEqual(await checkSubscription(f, projectSpacePath, other), { subscribed: false });
  assert.equal((await inbox(f, reviewer)).unreadCount, 0);
});

test('opening a physical database with the legacy notification subscription table keeps active and archived subscriptions', async t => {
  const f = await fixture(t);
  const ticket = await issue(f, editor, '기존 DB에 구독한 업무');
  const doc = await expectStatus(f.call<DocPage>('/documents', 'POST', { title: '기존 DB에 구독한 보관 문서' }), 201);
  const ticketPath = subscriptionPath('issue', ticket.id);
  const documentPath = subscriptionPath('document', doc.id);
  const projectPath = subscriptionPath('project', 'project-neo');
  const spacePath = subscriptionPath('space', 'common');
  await checkSubscription(f, ticketPath, reviewer, true);
  await checkSubscription(f, documentPath, other, true);
  const archived = await expectStatus(f.call<{ trashEntryId: string }>(`/documents/${doc.id}`, 'DELETE'));

  await f.restart(dataDir => {
    const db = new DatabaseSync(join(dataDir, 'teamspace.sqlite'));
    try {
      db.exec(`
        BEGIN;
        ALTER TABLE notification_subscriptions RENAME TO newer_subscriptions;
        CREATE TABLE notification_subscriptions (
          target_type TEXT NOT NULL CHECK(target_type IN ('issue','document')),
          target_id TEXT NOT NULL,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          PRIMARY KEY(target_type,target_id,user_id)
        );
        INSERT INTO notification_subscriptions SELECT target_type,target_id,user_id FROM newer_subscriptions;
        DROP TABLE newer_subscriptions;
        CREATE INDEX notification_subscriptions_user ON notification_subscriptions(user_id);
        COMMIT;
      `);
    } finally { db.close(); }
  });
  assert.deepEqual(await checkSubscription(f, ticketPath, reviewer), { subscribed: true });
  await checkSubscription(f, projectPath, reviewer, true);
  await checkSubscription(f, spacePath, collaborator, true);
  await expectStatus(f.call(documentPath, 'GET', undefined, other), 404);
  await expectStatus(f.call(`/trash/${archived.trashEntryId}/restore`, 'POST'));
  assert.deepEqual(await checkSubscription(f, documentPath, other), { subscribed: true });
  assert.equal((await inbox(f, collaborator)).unreadCount, 0);
  await comment(f, 'document', doc.id, editor);
  for (const watcher of [other, collaborator]) {
    assert.deepEqual((await inbox(f, watcher)).items.map(item => [item.targetId, item.kind]), [[doc.id, 'document-comment']]);
  }
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
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
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

test('deadline postponement uses the effective date and native backup preserves risk details and read state', async t => {
  const f = await fixture(t);
  let ticket = await issue(f, reviewer, '마감 변경 확인 업무', [reviewer, collaborator, editor]);
  const path = `/issues/${ticket.id}`;
  const issueSubscription = subscriptionPath('issue', ticket.id);
  const projectSubscription = subscriptionPath('project', ticket.projectId);
  for (const actor of [reviewer, collaborator, editor]) await checkSubscription(f, issueSubscription, actor, true);
  for (const actor of [reviewer, other, editor]) await checkSubscription(f, projectSubscription, actor, true);
  const patch = async (changes: Partial<Pick<Issue, 'dueDate' | 'endDate' | 'status'>>) => {
    ticket = await expectStatus(f.call<Issue>(path, 'PATCH', { expectedVersion: ticket.version, ...changes }));
  };

  await patch({ dueDate: '2026-11-20', endDate: '2026-11-22' });
  await patch({ endDate: '2026-11-25' });
  await patch({ dueDate: '2026-11-19' });
  await patch({ dueDate: '2026-11-19' });
  assert.deepEqual(await riskInbox(f, reviewer), []);

  await patch({ dueDate: '2026-11-21' });
  await patch({ dueDate: null });
  await patch({ endDate: null });
  await patch({ endDate: '2026-11-26' });
  await patch({ dueDate: '2026-11-26' });
  await patch({ status: 'done', endDate: '2026-11-28', dueDate: null });
  await patch({ endDate: '2026-11-30' });

  const expectedDetails = [
    '목표 마감일 2026-11-21 → 계획 종료일 2026-11-25',
    '목표 마감일 2026-11-19 → 목표 마감일 2026-11-21',
  ];
  const recipients = [reviewer, collaborator, other];
  for (const recipientId of recipients) {
    const items = await riskInbox(f, recipientId);
    assert.deepEqual(items.map(item => ({ ...event(item), detail: item.detail })), expectedDetails.map(detail => ({
      kind: 'issue-deadline-postponed', recipientId, actorId: editor, projectId: ticket.projectId,
      targetId: ticket.id, targetLabel: `${ticket.key} ${ticket.title}`, detail,
    })));
    assert.ok(items.every(item => item.readAt === null));
  }
  assert.deepEqual(await riskInbox(f, editor), []);

  const [latest, earlier] = await riskInbox(f, reviewer);
  const markRead = (id: string) => expectStatus(f.call(`/notifications/${id}/read`, 'PATCH', undefined, reviewer));
  await markRead(earlier.id);
  const saved = await riskInbox(f, reviewer);
  assert.equal(saved[0].readAt, null);
  assert.ok(saved[1].readAt);
  const backup = await expectStatus(f.call<Backup>('/export'));
  assert.equal(backup.schemaVersion, 62);
  assert.deepEqual(
    backup.teamNotifications.filter(item => item.recipientId === reviewer && isRiskNotification(item)),
    [...saved].reverse(),
  );
  await f.restart();
  const old = { ...backup, schemaVersion: 61 };
  const rejection = await expectStatus(f.call<{ error: string }>('/import', 'POST', { data: old }), 400);
  assert.match(rejection.error, /schemaVersion 62/);
  assert.deepEqual(await riskInbox(f, reviewer), saved);
  await markRead(latest.id);
  assert.deepEqual(await riskInbox(f, reviewer, '?filter=unread'), []);
  await expectStatus(f.call('/import', 'POST', { data: backup }));
  assert.deepEqual(await riskInbox(f, reviewer), saved);
  assert.deepEqual(await riskInbox(f, reviewer, '?filter=unread'), [saved[0]]);
  await expectStatus(f.call('/import', 'POST', {
    data: { ...old, teamNotifications: old.teamNotifications.filter(item => !isRiskNotification(item)) },
  }));
  assert.deepEqual(await riskInbox(f, reviewer), []);
});

test('failed risk notification insertion rolls back relation creation and the retried mutation notifies once', async t => {
  const f = await fixture(t);
  const source = await issue(f, editor, '트랜잭션에서 저장할 차단 원인');
  const target = await issue(f, reviewer, '차단되는 업무', [collaborator]);
  const path = `/issues/${source.id}/relations`;
  const request = { otherIssueId: target.id, type: 'blocks', direction: 'outgoing' };
  const restartWithSql = (sql: string) => f.restart(dataDir => {
    const db = new DatabaseSync(join(dataDir, 'teamspace.sqlite'));
    try { db.exec(sql); } finally { db.close(); }
  });
  await restartWithSql(`
    CREATE TRIGGER reject_issue_block_notification BEFORE INSERT ON team_notifications
    WHEN NEW.kind='issue-block-added' AND NEW.recipient_id='user-jun'
    BEGIN SELECT RAISE(ABORT, 'synthetic notification insertion failure'); END
  `);
  const before = await expectStatus(f.call<WorkspaceSnapshot>('/workspace'));
  await expectStatus(f.call(path, 'POST', request), 500);
  assert.deepEqual(await expectStatus(f.call<IssueRelation[]>(path)), []);
  assert.deepEqual(await expectStatus(f.call<IssueRelation[]>(`/issues/${target.id}/relations`)), []);
  assert.deepEqual(await expectStatus(f.call<WorkspaceSnapshot>('/workspace')), before);
  for (const recipient of [reviewer, collaborator]) assert.deepEqual(await riskInbox(f, recipient), []);

  await restartWithSql('DROP TRIGGER reject_issue_block_notification');
  const created = await expectStatus(f.call<IssueRelation>(path, 'POST', request), 201);
  assert.deepEqual(await expectStatus(f.call<IssueRelation>(path, 'POST', request)), created);
  assert.deepEqual(await expectStatus(f.call<IssueRelation[]>(path)), [created]);
  for (const recipientId of [reviewer, collaborator]) {
    const items = await riskInbox(f, recipientId);
    assert.deepEqual(items.map(item => ({ ...event(item), detail: item.detail })), [{
      kind: 'issue-block-added', recipientId, actorId: editor, projectId: target.projectId,
      targetId: target.id, targetLabel: `${target.key} ${target.title}`, detail: `${source.key} ${source.title}`,
    }]);
  }
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
