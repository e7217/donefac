import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { TrashArchive } from '../../server/trash.js';
import type { Issue, TrashRestoreResult, WorkspaceSnapshot } from '../../shared/types.js';

type Backup = { schemaVersion: number; issues: Issue[]; trashEntries: TrashArchive[] };

async function open(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-issue-reporter-backup-'));
  const app = createApp({ dataDir });
  const server = app.app.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return async function call<T = unknown>(path: string, status = 200, method = 'GET', data?: unknown, actorId?: string) {
    const response = await fetch(`http://127.0.0.1:${address.port}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(actorId ? { 'X-Actor-Id': actorId } : {}) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const result = await response.json() as T;
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result).slice(0, 700)}`);
    return result;
  };
}

function reporter(issue: Issue | undefined) {
  assert.ok(issue);
  return Object.hasOwn(issue, 'reporterId') ? issue.reporterId : 'absent';
}

test('native 84 preserves reporter, explicit blank and historical absence across live and trash restore', async t => {
  const from = await open(t);
  const to = await open(t);
  const { projects: [project], users: [actor, other], issues: [historical] } = await from<WorkspaceSnapshot>('/workspace');
  const create = (title: string, extra: Partial<Issue> = {}) => from<Issue>('/issues', 201, 'POST', {
    projectId: project.id, title, ...extra,
  }, actor.id);
  const current = await create('현재 요청자', { reporterId: other.id });
  const blank = await create('명시적 미지정', { reporterId: null });
  const archived = await create('휴지통 요청자');
  const { trashEntryId } = await from<{ trashEntryId: string }>(`/issues/${archived.id}?expectedVersion=${archived.version}`, 200, 'DELETE');
  const backup = await from<Backup>('/export');
  assert.equal(backup.schemaVersion, 84);
  const exportReporters = (data: Backup) => {
    const entry = data.trashEntries.find(value => value.id === trashEntryId);
    return [
      reporter(data.issues.find(issue => issue.id === current.id)),
      reporter(data.issues.find(issue => issue.id === blank.id)),
      reporter(data.issues.find(issue => issue.id === historical.id)),
      reporter(entry?.resourceType === 'issue' ? entry.resource : undefined),
    ];
  };
  const expected = [other.id, null, 'absent', actor.id];
  assert.deepEqual(exportReporters(backup), expected);
  await to('/import', 200, 'POST', { data: backup });
  assert.deepEqual(exportReporters(await to<Backup>('/export')), expected);

  const liveTampered = (value: unknown) => ({
    ...backup, issues: backup.issues.map(issue => issue.id === current.id ? { ...issue, reporterId: value } : issue),
  });
  const trashTampered = (value: unknown) => ({
    ...backup, trashEntries: backup.trashEntries.map(entry => entry.id === trashEntryId
      ? { ...entry, resource: { ...entry.resource, reporterId: value } } : entry),
  });
  for (const data of [liveTampered('missing-user'), liveTampered({ id: other.id }), trashTampered('missing-user'), trashTampered(false)]) {
    const failure = await to<{ error: string }>('/import', 400, 'POST', { data });
    assert.match(failure.error, /요청자/);
  }
  assert.deepEqual(exportReporters(await to<Backup>('/export')), expected);
  const restored = await to<TrashRestoreResult>(`/trash/${trashEntryId}/restore`, 200, 'POST');
  assert.equal(restored.resourceId, archived.id);
  assert.equal(reporter((await to<WorkspaceSnapshot>('/workspace')).issues.find(issue => issue.id === archived.id)), actor.id);

  await to('/import', 200, 'POST', { data: { ...backup, schemaVersion: 83 } });
  assert.deepEqual(exportReporters(await to<Backup>('/export')), expected);
  const oldFailure = await to<{ error: string }>('/import', 400, 'POST', { data: { ...trashTampered('missing-user'), schemaVersion: 83 } });
  assert.match(oldFailure.error, /요청자/);

  const legacy = { ...structuredClone(backup), schemaVersion: 83 };
  for (const issue of legacy.issues) delete issue.reporterId;
  for (const entry of legacy.trashEntries) if (entry.resourceType === 'issue') delete entry.resource.reporterId;
  await to('/import', 200, 'POST', { data: legacy });
  assert.deepEqual(exportReporters(await to<Backup>('/export')), ['absent', 'absent', 'absent', 'absent']);
  await to(`/trash/${trashEntryId}/restore`, 200, 'POST');
  assert.equal(reporter((await to<WorkspaceSnapshot>('/workspace')).issues.find(issue => issue.id === archived.id)), 'absent');
});
