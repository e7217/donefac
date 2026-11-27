import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import type {
  Issue, IssueChangeHistoryPage, JiraDeadlineRecoveryReview, LegacyPackageSummary, MigrationApplyResult, MigrationConfiguration,
  MigrationOptions, MigrationPreview, SourceRecordArchive, WorkspaceSnapshot,
} from '../../shared/types.js';
import { createApp } from '../../server/app.js';
import { jiraFieldDigest } from '../../server/migration-planner.js';

const sourceDate = '2027-02-15';
const originalUpdate = '2025-01-01T00:00:00.000Z';
const recoveryPath = (issueId: string) => `/issues/${issueId}/jira-deadline-recovery`;

interface SourceIssue {
  id: string;
  key?: string;
  title: string;
  updated?: string;
  dueDate: string | null;
}

async function fixture(t: TestContext, rows: SourceIssue[]) {
  const dataDir = mkdtempSync(join(tmpdir(), 'donefac-jira-deadline-recovery-'));
  const service = createApp({ dataDir, outboundWorker: false, deadlineReminderWorker: false, recurringIssueWorker: false });
  const database = new DatabaseSync(join(dataDir, 'donefac.sqlite'));
  const server = service.app.listen(0, '127.0.0.1');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    database.close();
    service.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  const actor = { 'X-Actor-Id': 'user-seo' };

  async function call<T = unknown>(path: string, method = 'GET', input?: unknown, status = 200): Promise<T> {
    const response = await fetch(base + path, {
      method, headers: { ...actor, 'Content-Type': 'application/json' },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    const body = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${body}`);
    return JSON.parse(body) as T;
  }

  async function stage(issues: SourceIssue[], filename: string) {
    const query = new URLSearchParams({ filename, product: 'jira', instanceKey: 'synthetic-rest-deadlines' });
    const response = await fetch(`${base}/legacy-import/packages?${query}`, {
      method: 'POST', headers: { ...actor, 'Content-Type': 'application/octet-stream' }, body: JSON.stringify({
        issues: issues.map(row => ({ id: row.id, key: row.key ?? `ORIG-${row.id}`, fields: {
          project: { id: '42', key: 'ORIG', name: 'Jira 원본 프로젝트' },
          summary: row.title, created: originalUpdate, updated: row.updated ?? originalUpdate, duedate: row.dueDate,
          status: { id: '1', name: 'Open' }, issuetype: { id: '3', name: 'Task' },
        }, changelog: { total: 0, histories: [] } })),
      }),
    });
    const body = await response.text();
    assert.equal(response.status, 201, body);
    const pkg = JSON.parse(body) as LegacyPackageSummary;
    return call<MigrationOptions>(`/migrations/options?packageId=${pkg.id}`);
  }

  async function migrate(configuration: MigrationConfiguration) {
    const plan = await call<MigrationPreview>('/migrations/preview', 'POST', { configuration }, 201);
    assert.equal(plan.canApply, true, JSON.stringify(plan.notices));
    return call<MigrationApplyResult>(`/migrations/previews/${plan.id}/apply`, 'POST', {
      expectedVersion: plan.version, acknowledgements: plan.requiredAcknowledgements,
    }, 201);
  }

  const initial = await migrate((await stage(rows, 'original.json')).defaultConfiguration);
  const [projectId] = initial.import.projectIds;
  const issues = (await call<WorkspaceSnapshot>('/workspace')).issues.filter(issue => issue.projectId === projectId);
  const issue = (title: string) => {
    const issue = issues.find(value => value.title === title);
    assert.ok(issue);
    return issue;
  };
  const current = async (id: string) => (await call<WorkspaceSnapshot>('/workspace')).issues.find(issue => issue.id === id);
  const review = async (id: string) => (await call<{ review: JiraDeadlineRecoveryReview | null }>(recoveryPath(id))).review;
  const repair = (id: string, revision: string, status = 200) => call<{ issue: Issue }>(recoveryPath(id), 'POST', { revision }, status);
  const patch = (old: Issue, changes: Partial<Issue>) => call<Issue>(`/issues/${old.id}`, 'PATCH', { expectedVersion: old.version, ...changes });

  function simulateLegacyDeadlineLoss(issue: Issue) {
    // Represent the old initial importer output while preserving the real REST record and binding.
    database.prepare(`UPDATE issues SET json=json_set(json,'$.dueDate',null) WHERE id=?`).run(issue.id);
    database.prepare(`UPDATE source_records SET json=json_set(json,'$.jiraIssueFieldHashes.dueDate',?)
        WHERE import_id=? AND kind='issue' AND target_id=?`).run(jiraFieldDigest('dueDate', null), initial.import.id, issue.id);
    return { ...issue, dueDate: null };
  }

  async function append(rows: SourceIssue[], refreshExisting = false) {
    const options = await stage(rows, 'subsequent.json');
    const target = options.appendTarget;
    assert.ok(target);
    return migrate({ ...options.defaultConfiguration, appendTo: {
      projectId, ...(refreshExisting ? { refreshExisting: true } : {}),
      statuses: Object.fromEntries(options.statuses.map(option => [option.id, target.statuses.find(status => status.label === option.label)!.id])),
      issueTypes: Object.fromEntries(options.issueTypes.map(option => [option.id, target.issueTypes.find(type => type.name === option.label)!.id])),
      fields: Object.fromEntries(options.fields.map(option => [option.id, null])),
    } });
  }

  return { issue, current, review, repair, patch, simulateLegacyDeadlineLoss, call, database, append };
}

test('recovers the archived REST deadline with exact review, preserves an unrelated edit, and records the field change', async t => {
  const f = await fixture(t, [
    { id: '111', title: '누락된 목표 마감일', dueDate: sourceDate },
    { id: '112', title: '원본 마감일 비어 있음', dueDate: null },
  ]);
  const original = f.issue('누락된 목표 마감일');
  assert.equal(original.dueDate, sourceDate);
  assert.equal(await f.review(original.id), null, 'correctly imported dates have no missing baseline');
  assert.equal(await f.review(f.issue('원본 마감일 비어 있음').id), null);
  const old = f.simulateLegacyDeadlineLoss(original);
  const first = await f.review(old.id);
  assert.ok(first);
  assert.deepEqual(first, { sourceImportId: first.sourceImportId, sourceRecordId: first.sourceRecordId,
    sourceKey: 'ORIG-111', sourceDueDate: sourceDate, currentDueDate: null, issueVersion: 1, status: 'ready', revision: first.revision });
  const archivePath = `/source-imports/${first.sourceImportId}/records/${first.sourceRecordId}`;
  const archive = await f.call<SourceRecordArchive>(archivePath);
  const renamed = await f.patch(old, { title: '팀에서 수정한 제목' });
  await f.repair(old.id, first.revision, 409);
  const reviewed = await f.review(old.id);
  assert.ok(reviewed && reviewed.status === 'ready' && reviewed.issueVersion === renamed.version);
  assert.notEqual(reviewed.revision, first.revision);
  await f.call(recoveryPath(old.id), 'POST', { revision: reviewed.revision, dueDate: '2027-02-20' }, 400);

  const { issue } = await f.repair(old.id, reviewed.revision);
  assert.deepEqual(issue, { ...renamed, updatedAt: issue.updatedAt, version: renamed.version + 1, dueDate: sourceDate });
  await f.repair(old.id, reviewed.revision, 409);
  assert.deepEqual(await f.current(old.id), issue);
  assert.deepEqual(await f.call(archivePath), archive);
  const current = await f.review(old.id);
  assert.ok(current && current.status === 'current-value' && current.currentDueDate === sourceDate);
  const { entries } = await f.call<IssueChangeHistoryPage>(`/issues/${old.id}/change-history`);
  assert.equal(entries[0].actorId, 'user-seo');
  assert.deepEqual(entries[0].changes.map(change => [change.field, change.before.value, change.after.value]), [['dueDate', null, sourceDate]]);
});

test('local clear and incomplete version history cannot be overwritten by archived due date', async t => {
  const f = await fixture(t, [
    { id: '121', title: '팀이 비운 업무', dueDate: sourceDate },
    { id: '122', title: '이전 변경 미확인', dueDate: sourceDate },
  ]);
  const local = f.simulateLegacyDeadlineLoss(f.issue('팀이 비운 업무'));
  const edited = await f.patch(local, { dueDate: '2027-02-20' });
  assert.equal((await f.review(local.id))?.status, 'current-value');
  const cleared = await f.patch(edited, { dueDate: null });
  const clearReview = await f.review(local.id);
  assert.ok(clearReview && clearReview.status === 'local-change');
  await f.repair(local.id, clearReview.revision, 409);
  assert.deepEqual(await f.current(local.id), cleared);

  const missing = f.simulateLegacyDeadlineLoss(f.issue('이전 변경 미확인'));
  f.database.prepare(`UPDATE issues SET json=json_set(json,'$.version',2) WHERE id=?`).run(missing.id);
  const gap = await f.review(missing.id);
  assert.ok(gap && gap.status === 'history-unverified');
  await f.repair(missing.id, gap.revision, 409);
  assert.equal((await f.current(missing.id))?.dueDate, null);
});

test('later bound Jira snapshots with contradictory due dates suppress the old recovery evidence', async t => {
  const f = await fixture(t, [{ id: '131', title: '다시 받은 Jira 업무', dueDate: sourceDate }]);
  const old = f.simulateLegacyDeadlineLoss(f.issue('다시 받은 Jira 업무'));
  const review = await f.review(old.id);
  assert.ok(review && review.status === 'ready');
  const fresh = await f.append([{ id: '131', title: old.title, updated: '2025-01-02T00:00:00.000Z', dueDate: '2027-02-16' }], true);
  const proof = await f.call<{ records: SourceRecordArchive[] }>(`/source-imports/${fresh.import.id}/records?kind=issue`);
  assert.ok(proof.records.some(row => row.targetId === old.id));
  assert.equal(await f.review(old.id), null);
  await f.repair(old.id, review.revision, 409);
  assert.equal((await f.current(old.id))?.dueDate, '2027-02-16');
});

test('archived-only later Jira issues can supersede or invalidate old deadline evidence without applying changes', async t => {
  const older = '2025-01-02T00:00:00.000Z';
  const initial = '2025-01-03T00:00:00.000Z';
  const later = '2025-01-04T00:00:00.000Z';
  const rows = [
    { id: '141', title: '보관한 원본에서 마감일 변경', updated: initial, dueDate: sourceDate },
    { id: '142', title: '보관한 원본에서 마감일 유지', updated: initial, dueDate: sourceDate },
    { id: '143', title: '이전 시각의 보관 원본', updated: initial, dueDate: sourceDate },
    { id: '144', title: '보관한 원본에서 ID와 키가 충돌', updated: initial, dueDate: sourceDate },
  ];
  const f = await fixture(t, rows);
  const issues = rows.map(row => f.simulateLegacyDeadlineLoss(f.issue(row.title)));
  const [changed, agreed, old, ambiguous] = issues;
  const before = await Promise.all(issues.map(issue => f.review(issue.id)));
  assert.ok(before.every(review => review?.status === 'ready'));

  const receipt = await f.append([
    { ...rows[0], updated: later, dueDate: null },
    { ...rows[1], updated: later },
    { ...rows[2], updated: older, dueDate: '2027-02-17' },
    { ...rows[3], id: '145', key: 'ORIG-144', updated: later },
    { id: '149', title: '같은 패키지의 새 업무', updated: later, dueDate: null },
  ]);
  const proof = await f.call<{ records: SourceRecordArchive[] }>(`/source-imports/${receipt.import.id}/records?kind=issue`);
  assert.deepEqual(proof.records.filter(row => row.targetId === null).map(row => row.record.sourceId).sort(), ['141', '142', '143', '145']);
  assert.equal(await f.review(changed.id), null);
  assert.equal(await f.review(ambiguous.id), null);
  await f.repair(changed.id, before[0]!.revision, 409);
  assert.equal((await f.current(changed.id))?.dueDate, null);
  assert.deepEqual(await f.review(old.id), before[2]);
  const current = await f.review(agreed.id);
  assert.ok(current?.status === 'ready');
  assert.notEqual(current.revision, before[1]!.revision);
  await f.repair(agreed.id, before[1]!.revision, 409);
  assert.equal((await f.repair(agreed.id, current.revision)).issue.dueDate, sourceDate);
});
