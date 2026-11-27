import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type {
  ApiKeyCreated, CycleCompletionPreview, CycleCompletionRecord, CycleCompletionRecordsPage, CycleCompletionResult,
  Issue, PlanningItem, Project, WorkspaceSnapshot,
} from '../../shared/types.js';

async function open(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'donefac-completion-records-backup-'));
  const service = createApp({ dataDir: directory });
  const server = service.app.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return async function request<T = unknown>(path: string, status = 200, method = 'GET', body?: unknown, headers?: Record<string, string>) {
    const response = await fetch(`http://127.0.0.1:${address.port}/api${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as T;
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result).slice(0, 1000)}`);
    return result;
  };
}

test('cycle record reads enforce project scope and native 80 restores deleted resource history without reusing its ticket key', async t => {
  const source = await open(t);
  const target = await open(t);
  const project = await source<Project>('/projects', 201, 'POST', { key: 'CUT80', name: '완료 이력 검증' });
  const plan = await source<PlanningItem>('/planning-items', 201, 'POST', {
    projectId: project.id, kind: 'cycle', name: '닫는 사이클', status: 'active', startDate: '2026-10-05', endDate: '2026-10-16',
  });
  const destination = await source<PlanningItem>('/planning-items', 201, 'POST', {
    projectId: project.id, kind: 'cycle', name: '이월 대상', status: 'planned',
  });
  const issue = await source<Issue>('/issues', 201, 'POST', { projectId: project.id, title: '완료 당시 업무', cycleId: plan.id });
  const lookup = `/projects/${project.id}/cycle-completion-records`;
  const completion = await source<CycleCompletionPreview>(`/planning-items/${plan.id}/complete/preview`, 200, 'POST', {
    expectedVersion: plan.version, destinationId: destination.id,
  });
  const applied = await source<CycleCompletionResult>(`/planning-items/${plan.id}/complete`, 200, 'POST', { previewId: completion.previewId });
  assert.ok(applied.recordId);
  const detail = `${lookup}/${applied.recordId}`;
  const record = await source<CycleCompletionRecord>(detail);
  assert.equal(record.destination?.name, '이월 대상');
  assert.equal(record.issues[0].id, issue.id);

  const readKey = await source<ApiKeyCreated>('/api-keys', 201, 'POST', { name: '완료 기록 읽기', projectIds: [project.id], access: 'read' });
  const headers = { Authorization: `Bearer ${readKey.token}` };
  const page = await source<CycleCompletionRecordsPage>(`/v1${lookup}?cycleId=${plan.id}&limit=1`, 200, 'GET', undefined, headers);
  assert.deepEqual(page.items.map(item => item.id), [record.id]);
  assert.equal(page.nextCursor, null);
  assert.equal(Object.hasOwn(page.items[0], 'issues'), false);
  assert.deepEqual(await source(`/v1${detail}`, 200, 'GET', undefined, headers), record);
  await source(`/v1/projects/project-neo/cycle-completion-records/${applied.recordId}`, 403, 'GET', undefined, headers);
  await source('/projects/project-neo/cycle-completion-records/' + applied.recordId, 404);
  await source(`/v1${lookup}?limit=1&limit=2`, 400, 'GET', undefined, headers);
  await source(`${lookup}?cycleId=${destination.id}&cursor=${record.id}`, 400);
  await source(`${detail}?limit=1`, 400);

  const deleted = await source<{ trashEntryId: string }>(`/issues/${issue.id}`, 200, 'DELETE', { expectedVersion: issue.version + 1 });
  await source(`/trash/${deleted.trashEntryId}`, 200, 'DELETE');
  await source(`/planning-items/${plan.id}?expectedVersion=${applied.cycle.version}`, 200, 'DELETE');
  await source(`/planning-items/${destination.id}?expectedVersion=${destination.version}`, 200, 'DELETE');
  assert.deepEqual(await source(detail), record);
  const backup = await source<{
    schemaVersion: number;
    cycleCompletionRecords: CycleCompletionRecord[];
    reportingLedger: { events: { before?: { projectId: string }; after?: { projectId: string } }[] };
  }>('/export');
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.deepEqual(backup.cycleCompletionRecords, [record]);
  // Exercise the key floor even when the ordinary reporting ledger has aged out the deleted ticket's entries.
  backup.reportingLedger.events = backup.reportingLedger.events.filter(event => (event.after ?? event.before)?.projectId !== project.id);
  const { cycleCompletionRecords, ...withoutRecords } = backup;
  await target('/import', 400, 'POST', { data: { ...backup, schemaVersion: 79 } });
  await target('/import', 200, 'POST', { data: { ...withoutRecords, schemaVersion: 79 } });
  assert.deepEqual(await target(lookup), { items: [], nextCursor: null });
  await target('/import', 200, 'POST', { data: backup });
  assert.deepEqual(await target(detail), record);
  const corrupted = { ...record, counts: { ...record.counts, carry: record.counts.carry + 1 } };
  await target('/import', 400, 'POST', { data: { ...withoutRecords, cycleCompletionRecords: [corrupted] } });
  assert.deepEqual(await target(detail), cycleCompletionRecords[0]);
  const restored = await target<WorkspaceSnapshot>('/workspace');
  assert.ok(!restored.issues.some(row => row.id === issue.id));
  assert.ok(!restored.planningItems?.some(row => row.id === plan.id || row.id === destination.id));
  const fresh = await target<Issue>('/issues', 201, 'POST', { projectId: project.id, title: '복원 후 새 업무' });
  assert.equal(fresh.key, 'CUT80-2');
});
