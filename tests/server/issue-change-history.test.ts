import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { IssueProjectMoveInput, IssueProjectMovePreview, IssueProjectMoveResult } from '../../shared/issue-project-move.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type {
  ApiKeyCreated, Issue, IssueBulkEditPreview, IssueBulkEditResult, IssueChangeHistoryEntry, IssueChangeHistoryPage, ProjectIssueSchema, ProjectWorkflow,
  SchedulePasteApplyResult, SchedulePastePreview, TrashRestoreResult, WorkspaceSnapshot,
} from '../../shared/types.js';

const projectId = 'project-neo';
const destinationId = 'project-team';
const actorId = 'user-min';
const colleagueId = 'user-seo';
const workflowPath = `/projects/${projectId}/workflow`;
const schemaPath = `/projects/${projectId}/issue-schema`;

type Backup = { schemaVersion: number; issueChangeHistory?: IssueChangeHistoryEntry[] };

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'donefac-issue-change-history-'));
  async function start() {
    const service = createApp({ dataDir, outboundWorker: false, deadlineReminderWorker: false });
    const server = service.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return { base: `http://127.0.0.1:${address.port}/api`, async close() {
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      service.close();
    } };
  }
  let active = await start();
  t.after(async () => {
    try { await active.close(); }
    finally { rmSync(dataDir, { recursive: true, force: true }); }
  });
  async function call<T = unknown>(path: string, status = 200, method = 'GET', body?: unknown, token?: string, requestedActor: string | null = actorId) {
    const response = await fetch(active.base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(requestedActor && { 'X-Actor-Id': requestedActor }),
        ...(token && { Authorization: `Bearer ${token}` }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const contents = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${contents.slice(0, 1200)}`);
    return JSON.parse(contents) as T;
  }
  async function key(access: 'read' | 'write', projectIds: string[] | null) {
    return (await call<ApiKeyCreated>('/api-keys', 201, 'POST', {
      name: `필드 변경 이력 ${access} ${projectIds?.join(' ') ?? '전체'}`, access, projectIds, expiresAt: null,
    })).token;
  }
  const issue = (title: string, fields: Partial<Issue> = {}) => call<Issue>('/issues', 201, 'POST', { projectId, title, ...fields });
  const update = (issue: Issue, fields: Partial<Issue>, status = 200) =>
    call<Issue>(`/issues/${issue.id}`, status, 'PATCH', { expectedVersion: issue.version, ...fields });
  const history = (id: string, beforeVersion?: number, token?: string) => call<IssueChangeHistoryPage>(
    `${token ? '/v1' : ''}/issues/${id}/change-history${beforeVersion === undefined ? '' : `?beforeVersion=${beforeVersion}`}`,
    200, 'GET', undefined, token,
  );
  return { call, key, issue, update, history, dataDir, async restart() { await active.close(); active = await start(); } };
}

function values(entry: IssueChangeHistoryEntry) {
  return new Map(entry.changes.map(change => [change.field, change]));
}

test('native field changes capture the authorized editor and historical workflow, person and custom option labels', async t => {
  const f = await fixture(t);
  const { users } = await f.call<WorkspaceSnapshot>('/workspace');
  const editor = users.find(user => user.id === actorId)!;
  const colleague = users.find(user => user.id === colleagueId)!;
  const workflow = await f.call<ProjectWorkflow>(workflowPath);
  const statusNames = new Map(workflow.statuses.map(status => [status.id, status.label]));
  const beforeSchema = await f.call<ProjectIssueSchema>(schemaPath);
  const schema = await f.call<ProjectIssueSchema>(schemaPath, 200, 'PATCH', {
    ...beforeSchema, expectedVersion: beforeSchema.version, fields: [...beforeSchema.fields, {
      id: 'decision', name: '당시 검토 결과', description: '', kind: 'select', required: false, archived: false, issueTypes: [],
      options: [{ id: 'pending', name: '당시 보류', archived: false }, { id: 'approved', name: '당시 승인', archived: false }],
    }],
  });
  const original = await f.issue('업무 필드 변경 견본', { status: 'todo', customFields: { decision: 'pending' } });
  assert.deepEqual(await f.history(original.id), { entries: [], nextBeforeVersion: null });
  const writer = await f.key('write', [projectId]);
  const patchPath = `/v1/issues/${original.id}`;
  const patched = await f.call<Issue>(patchPath, 200, 'PATCH', {
    expectedVersion: original.version, actorId: colleagueId, status: 'review', priority: 'high', assigneeId: colleagueId,
    dueDate: '2027-01-14', customFields: { decision: 'approved' },
  }, writer);
  const initial = await f.history(original.id);
  assert.equal(initial.entries.length, 1);
  assert.equal(initial.nextBeforeVersion, null);
  const [entry] = initial.entries;
  assert.equal(entry.issueId, original.id);
  assert.equal(entry.projectId, projectId);
  assert.equal(entry.previousProjectId, projectId);
  assert.equal(entry.issueVersion, patched.version);
  assert.equal(entry.actorId, actorId);
  assert.equal(entry.actorName, editor.name);
  assert.equal(entry.origin, 'user');
  assert.equal(entry.occurredAt, patched.updatedAt);
  const changes = values(entry);
  assert.deepEqual([...changes.keys()].sort(), ['assigneeId', 'custom:decision', 'dueDate', 'priority', 'status']);
  assert.deepEqual(changes.get('status')?.before, { value: 'todo', display: statusNames.get('todo') });
  assert.deepEqual(changes.get('status')?.after, { value: 'review', display: statusNames.get('review') });
  assert.deepEqual(changes.get('custom:decision'), {
    field: 'custom:decision', label: '당시 검토 결과',
    before: { value: 'pending', display: '당시 보류' }, after: { value: 'approved', display: '당시 승인' },
  });
  assert.deepEqual(changes.get('assigneeId')?.after, { value: colleagueId, display: colleague.name });
  assert.equal(changes.get('dueDate')?.before.value, null);
  assert.equal(changes.get('dueDate')?.after.value, '2027-01-14');

  await f.call(patchPath, 409, 'PATCH', { expectedVersion: original.version, status: 'review' }, writer);
  await f.update(patched, { title: patched.title });
  await f.call(`/users/${actorId}`, 200, 'PATCH', { name: '변경 이후 작업자 이름' });
  await f.call(`/users/${colleagueId}`, 200, 'PATCH', { name: '변경 이후 담당자 이름' });
  await f.call(workflowPath, 200, 'PATCH', {
    ...workflow, expectedVersion: workflow.version,
    statuses: workflow.statuses.map(status => status.id === 'review' ? { ...status, label: '새 검토 단계 이름' } : status),
  });
  await f.call(schemaPath, 200, 'PATCH', {
    ...schema, expectedVersion: schema.version, fields: schema.fields.map(field => field.id === 'decision'
      ? { ...field, name: '새 검토 필드 이름', options: field.options.map(option => ({ ...option, name: `변경 ${option.id}` })) } : field),
  });
  await f.restart();
  assert.deepEqual(await f.history(original.id, undefined, writer), initial);
  assert.deepEqual(await f.history(original.id, patched.version), { entries: [], nextBeforeVersion: null });

  const fallback = await f.issue('작업자 기본값 확인');
  const fallbackPath = `/issues/${fallback.id}`;
  const changedByDefault = await f.call<Issue>(fallbackPath, 200, 'PATCH', {
    expectedVersion: fallback.version, title: '작업자 없이 저장',
  }, undefined, null);
  await f.call(fallbackPath, 200, 'PATCH', {
    expectedVersion: changedByDefault.version, title: '빈 작업자로 저장', actorId: '',
  }, undefined, null);
  assert.deepEqual((await f.history(fallback.id)).entries.map(row => [row.actorId, row.actorName]),
    [[users[0].id, '변경 이후 작업자 이름'], [users[0].id, '변경 이후 작업자 이름']]);
});

test('bulk and Gantt mutations record committed before and after values, roll back together, and survive native trash restore', async t => {
  const f = await fixture(t);
  const first = await f.issue('합성 일괄 변경 첫 업무', { startDate: '2027-01-11', endDate: '2027-01-12', priority: 'medium' });
  const second = await f.issue('합성 일괄 변경 두 번째 업무', { priority: 'medium' });
  const bulkPath = `/projects/${projectId}/issues/bulk`;
  const bulk = await f.call<IssueBulkEditPreview>(`${bulkPath}-preview`, 200, 'POST', {
    issues: [first, second].map(({ id, version }) => ({ id, expectedVersion: version })), changes: { priority: 'high' },
  });
  assert.ok(bulk.previewId);
  const db = new DatabaseSync(join(f.dataDir, 'donefac.sqlite'));
  try {
    db.exec(`CREATE TRIGGER reject_second_field_change BEFORE UPDATE ON issues
      WHEN json_extract(NEW.json, '$.title') = '합성 일괄 변경 두 번째 업무'
      BEGIN SELECT RAISE(ABORT, 'synthetic field history bulk rollback'); END`);
    await f.call(`${bulkPath}-apply`, 500, 'POST', { previewId: bulk.previewId });
    assert.deepEqual((await f.history(first.id)).entries, []);
    assert.deepEqual((await f.history(second.id)).entries, []);
    assert.equal((await f.call<WorkspaceSnapshot>('/workspace')).issues.find(issue => issue.id === first.id)?.priority, 'medium');
    db.exec('DROP TRIGGER reject_second_field_change');
  } finally { db.close(); }
  const applied = await f.call<IssueBulkEditResult>(`${bulkPath}-apply`, 200, 'POST', { previewId: bulk.previewId });
  const replay = await f.call<IssueBulkEditResult>(`${bulkPath}-apply`, 200, 'POST', { previewId: bulk.previewId });
  assert.deepEqual(replay, applied);
  const reviewed = applied.updated.find(issue => issue.id === first.id)!;
  const [row] = (await f.history(first.id)).entries;
  assert.equal(values(row).get('priority')?.before.value, 'medium');
  assert.equal(values(row).get('priority')?.after.value, 'high');
  assert.equal((await f.history(second.id)).entries.length, 1);

  const proposal = await f.call<SchedulePastePreview>('/schedule/row-edit/preview', 200, 'POST', {
    projectId, issue: { id: first.id, expectedVersion: reviewed.version }, changes: { endDate: '2027-01-15' },
  });
  assert.ok(proposal.previewId);
  const scheduled = await f.call<SchedulePasteApplyResult>('/schedule/row-edit/apply', 200, 'POST', { previewId: proposal.previewId });
  assert.deepEqual(await f.call<SchedulePasteApplyResult>('/schedule/row-edit/apply', 200, 'POST', { previewId: proposal.previewId }), scheduled);
  const undo = await f.call<SchedulePasteApplyResult>('/schedule/undo', 200, 'POST', { undoId: scheduled.undoId });
  const [undone] = undo.updated;
  const before = await f.history(first.id);
  assert.deepEqual(before.entries.map(entry => entry.issueVersion), [undone.version, scheduled.updated[0].version, reviewed.version]);
  assert.deepEqual(before.entries.slice(0, 2).map(entry => {
    const end = values(entry).get('endDate')!;
    return [end.before.value, end.after.value];
  }), [['2027-01-15', '2027-01-12'], ['2027-01-12', '2027-01-15']]);
  const { trashEntryId } = await f.call<{ trashEntryId: string }>(`/issues/${first.id}?expectedVersion=${undone.version}`, 200, 'DELETE');
  await f.call(`/issues/${first.id}/change-history`, 404);
  const backup = await f.call<Backup>('/export');
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  const exported = backup.issueChangeHistory!;
  assert.deepEqual(exported.filter(entry => entry.issueId === first.id).sort((a, b) => b.issueVersion - a.issueVersion), before.entries);

  const restored = await fixture(t);
  const corrupt = { ...backup, issueChangeHistory: [{ ...exported[0], issueId: 'missing-issue' }, ...exported.slice(1)] };
  await restored.call('/import', 400, 'POST', { data: corrupt });
  await restored.call('/import', 200, 'POST', { data: backup });
  const { resourceId } = await restored.call<TrashRestoreResult>(`/trash/${trashEntryId}/restore`, 200, 'POST');
  assert.equal(resourceId, first.id);
  assert.deepEqual(await restored.history(first.id), before);
  const live = (await restored.call<WorkspaceSnapshot>('/workspace')).issues.find(issue => issue.id === first.id)!;
  const archivedAgain = await restored.call<{ trashEntryId: string }>(`/issues/${first.id}?expectedVersion=${live.version}`, 200, 'DELETE');
  await restored.call(`/trash/${archivedAgain.trashEntryId}`, 200, 'DELETE');
  const afterPurge = await restored.call<Backup>('/export');
  assert.deepEqual(afterPurge.issueChangeHistory?.map(entry => entry.issueId), [second.id]);

  const legacy = { ...backup, schemaVersion: 87 };
  await restored.call('/import', 400, 'POST', { data: legacy });
  delete legacy.issueChangeHistory;
  await restored.call('/import', 200, 'POST', { data: legacy });
  await restored.call(`/trash/${trashEntryId}/restore`, 200, 'POST');
  assert.deepEqual(await restored.history(first.id), { entries: [], nextBeforeVersion: null });
});

test('a project key receives only permitted historical rows and paginates without counting inaccessible records', async t => {
  const f = await fixture(t);
  const sourceReader = await f.key('read', [projectId]);
  const destinationReader = await f.key('read', [destinationId]);
  const bothReader = await f.key('read', [projectId, destinationId]);
  const entireWorkspace = await f.key('read', null);
  const initial = await f.issue('프로젝트 이동 전 필드 이력');
  const before = await f.update(initial, { title: '이전 프로젝트에서 변경한 제목' });
  const historyPath = `/v1/issues/${initial.id}/change-history`;
  await f.call(historyPath, 403, 'GET', undefined, destinationReader);
  assert.deepEqual((await f.history(initial.id, undefined, sourceReader)).entries.map(row => row.issueVersion), [before.version]);
  const move: IssueProjectMoveInput = { expectedVersion: before.version, projectId: destinationId, includeConnected: false, mappings: [] };
  const path = `/issues/${initial.id}/project-move`;
  const preview = await f.call<IssueProjectMovePreview>(`${path}/preview`, 200, 'POST', move);
  assert.ok(preview.token);
  const moved = await f.call<IssueProjectMoveResult>(`${path}/apply`, 200, 'POST', { ...move, token: preview.token });
  let current = moved.issues.find(issue => issue.id === initial.id)!;
  await f.call(historyPath, 403, 'GET', undefined, sourceReader);
  assert.deepEqual(await f.history(initial.id, undefined, destinationReader), { entries: [], nextBeforeVersion: null });
  const all = await f.history(initial.id, undefined, bothReader);
  assert.deepEqual(all.entries.map(row => [row.projectId, row.previousProjectId]), [[destinationId, projectId], [projectId, projectId]]);
  assert.deepEqual(await f.history(initial.id, undefined, entireWorkspace), all);
  for (let i = 1; i <= 20; i++) current = await f.update(current, { title: `현재 프로젝트 변경 ${i}` });
  const firstPage = await f.history(initial.id, undefined, destinationReader);
  assert.equal(firstPage.entries.length, 20);
  assert.equal(firstPage.nextBeforeVersion, null);
  assert.ok((await f.history(initial.id, undefined, bothReader)).nextBeforeVersion);
  const next = await f.update(current, { title: '현재 프로젝트 변경 21' });
  const withNext = await f.history(initial.id, undefined, destinationReader);
  assert.equal(withNext.entries.length, 20);
  assert.equal(withNext.entries[0].issueVersion, next.version);
  assert.equal(withNext.nextBeforeVersion, withNext.entries.at(-1)?.issueVersion);
  const last = await f.history(initial.id, withNext.nextBeforeVersion!, destinationReader);
  assert.deepEqual(last, { entries: [firstPage.entries.at(-1)], nextBeforeVersion: null });
  for (const query of ['beforeVersion=0', 'beforeVersion=2&beforeVersion=3', 'unknown=2']) {
    await f.call(`${historyPath}?${query}`, 400, 'GET', undefined, destinationReader);
  }
});
