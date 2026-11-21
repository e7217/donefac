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
import type { TrashArchive } from '../../server/trash.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type {
  ApiKeyCreated, DocPage, DocRevision, DocumentPublicationList, DocumentPublicationState, DocumentPublicationView,
  RichContent, TeamNotification, TeamNotificationPage, TeamOverviewResult, User, WorkspaceSnapshot,
} from '../../shared/types.js';

type Backup = WorkspaceSnapshot & {
  schemaVersion: number;
  documentPublications: DocumentPublicationState[];
  teamNotifications: TeamNotification[];
  trashEntries: TrashArchive[];
};
type ReviewAction = 'request' | 'approve' | 'publish' | 'request_changes' | 'withdraw';
const author = 'user-min';
const first = 'user-seo';
const second = 'user-jun';
const documentPath = (id: string) => `/documents/${id}`;
const publicationPath = (id: string) => `${documentPath(id)}/publication`;
function content(text: string): RichContent {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-document-publication-group-'));
  const service = createApp({ dataDir, outboundWorker: false, recurringIssueWorker: false, deadlineReminderWorker: false });
  const server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const database = new DatabaseSync(join(dataDir, 'teamspace.sqlite'));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    database.close();
    service.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function call<T = unknown>(path: string, method = 'GET', body?: unknown, status = 200, actor = author, headers?: Record<string, string>) {
    const response = await fetch(base + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actor, ...headers },
    });
    const raw = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${raw}`);
    return JSON.parse(raw) as T;
  }

  const document = (text: string) => call<DocPage>('/documents', 'POST', {
    projectId: 'project-neo', title: `합성 검토 ${randomUUID()}`, content: content(text),
  }, 201);
  const edit = (before: DocPage, text: string) => call<DocPage>(documentPath(before.id), 'PATCH', {
    expectedVersion: before.version, title: `${before.title} 이후 초안`, content: content(text),
  });
  const state = (id: string) => call<DocumentPublicationView>(publicationPath(id));
  const action = (before: DocumentPublicationView, name: ReviewAction, actor = author, extra: Record<string, unknown> = {}, status = 200, token?: string) =>
    call<DocumentPublicationView>(`${token ? '/v1' : ''}${publicationPath(before.documentId)}`, 'POST', {
      action: name, expectedVersion: before.version, workspaceGeneration: before.workspaceGeneration, ...extra,
    }, status, actor, token ? { Authorization: `Bearer ${token}` } : undefined);
  const ask = async (doc: DocPage, reviewers = [first, second]) => action(await state(doc.id), 'request', author, {
    expectedDocumentVersion: doc.version, reviewerIds: reviewers, note: '모든 검토자에게 보낸 메모',
  });
  const snapshot = (view: DocumentPublicationView, kind: 'review' | 'published') => {
    const pointer = view[kind];
    assert.ok(pointer);
    return call<DocRevision>(`${publicationPath(view.documentId)}/snapshot?${new URLSearchParams({ kind, revisionId: pointer.revisionId })}`);
  };
  const list = (actor: string, tab: DocumentPublicationList['tab'] = 'assigned') =>
    call<DocumentPublicationList>(`/document-publications?tab=${tab}`, 'GET', undefined, 200, actor);
  const notifications = async (id: string, actor: string) => (await call<TeamNotificationPage>('/notifications', 'GET', undefined, 200, actor)).items
    .filter(item => item.targetId === id);
  const exportBackup = () => call<Backup>('/export');
  const restoreBackup = (data: Backup, status = 200) => call('/import', 'POST', { data }, status);
  return { database, call, document, edit, state, action, ask, snapshot, list, notifications, exportBackup, restoreBackup };
}

test('group review pins one snapshot, tracks each pending reviewer, and publishes only after every reviewer approves', async t => {
  const f = await fixture(t);
  const third = await f.call<User>('/users', 'POST', { name: '합성 추가 검토자', email: 'reviewer@example.test', color: '#225588' }, 201);
  const reviewers = [first, second, third.id];
  const doc = await f.document('팀이 검토할 고정 본문');
  const initial = await f.state(doc.id);
  for (const reviewerIds of [[], [first, first], [first, author], [first, 'missing-user'], [first, 3], Array.from({ length: 21 }, (_, i) => `reviewer-${i}`)]) {
    await f.action(initial, 'request', author, { expectedDocumentVersion: doc.version, reviewerIds }, 400);
  }
  await f.action(initial, 'request', author, { expectedDocumentVersion: doc.version, reviewerIds: reviewers, reviewerId: first }, 400);
  assert.deepEqual(await f.state(doc.id), initial);

  const requested = await f.ask(doc, reviewers);
  assert.equal(requested.version, initial.version + 1);
  assert.equal(requested.review!.reviewerId, first);
  assert.deepEqual(requested.review!.reviewers, reviewers.map(reviewerId => ({ reviewerId, approval: null })));
  assert.equal(requested.published, null);
  const frozen = await f.snapshot(requested, 'review');
  assert.deepEqual(frozen.content, doc.content);
  for (const reviewer of reviewers) {
    const inbox = await f.list(reviewer);
    assert.equal(inbox.pendingAssigned, 1);
    assert.deepEqual(inbox.items.map(item => item.documentId), [doc.id]);
    assert.deepEqual(inbox.items[0].reviewerIds, reviewers);
    assert.equal(inbox.items[0].approvedCount, 0);
    assert.deepEqual((await f.notifications(doc.id, reviewer)).map(item => item.kind), ['document-review-requested']);
  }
  assert.equal((await f.list(author)).pendingAssigned, 0);
  await f.action(requested, 'publish', first, {}, 409);
  await f.action(requested, 'approve', author, {}, 403);

  const newer = await f.edit(doc, '검토 뒤 저장한 별도 초안 본문');
  const partial = await f.action(requested, 'approve', second, { note: '  두 번째 지정 검토자의 승인  ' });
  assert.equal(partial.version, requested.version + 1);
  assert.equal(partial.documentVersion, newer.version);
  assert.equal(partial.published, null);
  const secondApproval = partial.review!.reviewers![1].approval;
  assert.ok(secondApproval);
  assert.equal(secondApproval.byId, second);
  assert.equal(secondApproval.note, '두 번째 지정 검토자의 승인');
  assert.deepEqual(partial.review!.reviewers!.map(seat => seat.approval), [null, secondApproval, null]);
  assert.deepEqual(await f.snapshot(partial, 'review'), frozen);
  await f.action(requested, 'approve', first, {}, 409);
  await f.action(partial, 'approve', second, {}, 409);
  assert.deepEqual(await f.state(doc.id), partial);
  assert.equal((await f.list(first)).pendingAssigned, 1);
  assert.equal((await f.list(second)).pendingAssigned, 0);
  assert.equal((await f.list(second)).total, 0);
  const requestedList = await f.list(author, 'requested');
  assert.equal(requestedList.items[0].approvedCount, 1);
  assert.equal(requestedList.items[0].revision.title, doc.title);
  assert.ok(!JSON.stringify(requestedList).includes(secondApproval.note));
  const reviewed = await f.call<TeamOverviewResult>(`/team-overview?projectId=project-neo&memberId=${second}`);
  const outstanding = await f.call<TeamOverviewResult>(`/team-overview?projectId=project-neo&memberId=${third.id}`);
  const overview = await f.call<TeamOverviewResult>('/team-overview?projectId=project-neo');
  assert.equal(reviewed.reviews.total, 0);
  assert.equal(outstanding.reviews.total, 1);
  assert.equal(outstanding.reviews.items[0].documentId, doc.id);
  assert.deepEqual(overview.reviews.items.map(item => item.documentId), [doc.id]);
  assert.deepEqual((await f.notifications(doc.id, author)).map(item => [item.kind, item.actorId]), [['document-review-approved', second]]);

  const almost = await f.action(partial, 'approve', first, { note: '첫 번째 지정 검토자의 승인' });
  const firstApproval = almost.review!.reviewers![0].approval;
  assert.ok(firstApproval);
  assert.equal(almost.published, null);
  const key = await f.call<ApiKeyCreated>('/api-keys', 'POST', {
    name: '합성 그룹 검토 키', access: 'write', projectIds: ['project-neo'], expiresAt: null,
  }, 201, third.id);
  const result = await f.action(almost, 'approve', first, { note: '세 번째 지정 검토자의 승인' }, 200, key.token);
  assert.equal(result.review, null);
  assert.equal(result.published!.revisionId, frozen.id);
  assert.equal(result.published!.publishedById, third.id);
  assert.equal(result.published!.reviewerId, third.id);
  assert.equal(result.published!.note, '세 번째 지정 검토자의 승인');
  assert.deepEqual(result.published!.approvals, [firstApproval, secondApproval, {
    byId: third.id, at: result.published!.publishedAt, note: result.published!.note,
  }]);
  assert.deepEqual(await f.snapshot(result, 'published'), frozen);
  assert.equal((await f.call<WorkspaceSnapshot>('/workspace')).documents.find(item => item.id === doc.id)!.plainText, newer.plainText);
  assert.deepEqual((await f.list(author, 'published')).items[0].reviewerIds, reviewers);
  assert.equal((await f.list(author, 'published')).items[0].approvedCount, reviewers.length);
  assert.equal((await f.list(third.id)).pendingAssigned, 0);
  for (const recipient of [author, first, second]) {
    assert.equal((await f.notifications(doc.id, recipient)).filter(item => item.kind === 'document-published').length, 1);
  }
});

test('partial approval rolls back with its notification and a pending reviewer can stop the whole review', async t => {
  const f = await fixture(t);
  let doc = await f.document('기존 발행 본문');
  const single = await f.action(await f.state(doc.id), 'request', author, { expectedDocumentVersion: doc.version, reviewerId: first });
  assert.ok(!Object.hasOwn(single.review!, 'reviewers'));
  const published = await f.action(single, 'publish', first);
  assert.ok(!Object.hasOwn(published.published!, 'approvals'));

  doc = await f.edit(doc, '여러 명이 검토할 다음 본문');
  const requested = await f.ask(doc);
  const countActivity = () => (f.database.prepare("SELECT COUNT(*) AS count FROM activities WHERE json_extract(json,'$.resourceId')=?").get(doc.id) as { count: number }).count;
  const baselineCount = countActivity();
  const baselineInbox = await f.notifications(doc.id, author);
  f.database.exec(`CREATE TRIGGER reject_group_approval_notice BEFORE INSERT ON team_notifications
    WHEN NEW.kind='document-review-approved' BEGIN SELECT RAISE(ABORT,'synthetic group approval notification failure'); END`);
  try {
    await f.action(requested, 'approve', first, { note: '보관할 승인 메모' }, 500);
    assert.equal(countActivity(), baselineCount);
    assert.deepEqual(await f.notifications(doc.id, author), baselineInbox);
    assert.deepEqual(await f.state(doc.id), requested);
    assert.equal((await f.list(first)).pendingAssigned, 1);
  } finally {
    f.database.exec('DROP TRIGGER reject_group_approval_notice');
  }

  const partial = await f.action(requested, 'approve', first, { note: '보관할 승인 메모' });
  assert.equal(countActivity(), baselineCount + 1);
  await f.action(partial, 'request_changes', first, { note: '이미 판단한 검토자의 수정 요청' }, 409);
  await f.action(partial, 'request_changes', second, { note: '   ' }, 400);
  const blocked = await f.action(partial, 'request_changes', second, { note: '확인 근거를 추가해 주세요.' });
  assert.equal(blocked.review!.changesRequested!.byId, second);
  assert.deepEqual(blocked.review!.reviewers, partial.review!.reviewers);
  assert.deepEqual(blocked.published, published.published);
  assert.equal((await f.list(second)).pendingAssigned, 0);
  assert.equal((await f.list(author, 'requested')).items[0].status, 'changes_requested');
  assert.equal((await f.list(author, 'requested')).items[0].approvedCount, 1);
  assert.equal((await f.notifications(doc.id, first)).filter(item => item.kind === 'document-changes-requested').length, 1);
  await f.action(blocked, 'approve', second, {}, 409);

  doc = await f.edit(doc, '근거를 포함해 다시 요청한 본문');
  const resubmitted = await f.ask(doc, [second, first]);
  assert.notEqual(resubmitted.review!.revisionId, blocked.review!.revisionId);
  assert.equal(resubmitted.review!.changesRequested, null);
  assert.deepEqual(resubmitted.review!.reviewers, [second, first].map(reviewerId => ({ reviewerId, approval: null })));
  await f.action(resubmitted, 'withdraw', second, {}, 403);
  const withdrawn = await f.action(resubmitted, 'withdraw');
  assert.equal(withdrawn.review, null);
  assert.deepEqual(withdrawn.published, published.published);
  for (const reviewer of [first, second]) {
    assert.equal((await f.notifications(doc.id, reviewer)).filter(item => item.kind === 'document-review-withdrawn').length, 1);
  }
});

test('native group review backs up active and trashed decisions and rejects incompatible or invalid histories', async t => {
  const f = await fixture(t);
  const doc = await f.document('복원할 진행 중 검토');
  const active = await f.action(await f.ask(doc), 'approve', first, { note: '진행 중인 승인 메모' });
  const trashedDoc = await f.document('휴지통에서 복원할 다중 검토');
  const firstPending = await f.action(await f.ask(trashedDoc), 'approve', first, { note: '발행으로 이어진 첫 승인' });
  const finished = await f.action(firstPending, 'approve', second, { note: '발행으로 이어진 마지막 승인' });
  const { trashEntryId } = await f.call<{ trashEntryId: string }>(`${documentPath(trashedDoc.id)}?expectedVersion=${trashedDoc.version}`, 'DELETE');
  const backup = await f.exportBackup();
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.ok(backup.schemaVersion >= 91);
  const activeRecord = (data: Backup) => data.documentPublications.find(item => item.documentId === doc.id)!;
  const archiveRecord = (data: Backup) => data.trashEntries.find(entry => entry.id === trashEntryId)!.publication!;
  assert.deepEqual(activeRecord(backup).review, active.review);
  assert.deepEqual(archiveRecord(backup).published, finished.published);
  assert.ok(backup.teamNotifications.some(item => item.kind === 'document-review-approved' && item.targetId === doc.id));

  const malformed: ((candidate: Backup) => void)[] = [
    data => {
      data.schemaVersion = 90;
      data.teamNotifications = data.teamNotifications.filter(item => item.kind !== 'document-review-approved');
      delete archiveRecord(data).published!.approvals;
    },
    data => {
      data.schemaVersion = 90;
      data.teamNotifications = data.teamNotifications.filter(item => item.kind !== 'document-review-approved');
      delete activeRecord(data).review!.reviewers;
    },
    data => {
      data.schemaVersion = 90;
      delete activeRecord(data).review!.reviewers;
      delete archiveRecord(data).published!.approvals;
    },
    data => { activeRecord(data).review!.reviewers![1].reviewerId = first; },
    data => { activeRecord(data).review!.reviewers![0].approval!.byId = second; },
    data => { activeRecord(data).review!.reviewers![0].approval!.at = '2000-01-01T00:00:00.000Z'; },
    data => {
      const reviewers = activeRecord(data).review!.reviewers!;
      reviewers[1].approval = { byId: second, at: reviewers[0].approval!.at, note: '이미 모두 승인된 활성 요청' };
    },
    data => { archiveRecord(data).published!.approvals!.pop(); },
    data => { archiveRecord(data).published!.approvals![1].note = '최종 발행과 다른 메모'; },
  ];
  for (const corrupt of malformed) {
    const invalid = structuredClone(backup);
    corrupt(invalid);
    await f.restoreBackup(invalid, 400);
    assert.deepEqual(await f.state(doc.id), active);
  }

  await f.restoreBackup(backup);
  const restored = await f.state(doc.id);
  assert.notEqual(restored.workspaceGeneration, active.workspaceGeneration);
  assert.deepEqual(restored.review, active.review);
  await f.action(active, 'approve', second, {}, 409);
  assert.equal((await f.list(first)).pendingAssigned, 0);
  assert.equal((await f.list(second)).pendingAssigned, 1);
  assert.deepEqual((await f.exportBackup()).teamNotifications, backup.teamNotifications);
  await f.call(`/trash/${trashEntryId}/restore`, 'POST', {});
  const restoredArchive = await f.state(trashedDoc.id);
  assert.equal(restoredArchive.version, finished.version + 1);
  assert.deepEqual(restoredArchive.published, finished.published);
  assert.equal((await f.snapshot(restoredArchive, 'published')).plainText, trashedDoc.plainText);
  const completed = await f.action(restored, 'approve', second);
  assert.deepEqual(completed.published!.approvals!.map(approval => approval.byId), [first, second]);
  assert.deepEqual(f.database.prepare('PRAGMA foreign_key_check').all(), []);
});
