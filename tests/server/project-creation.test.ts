import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createApp } from '../../server/app.js';
import type { Issue, Project, WorkspaceSnapshot } from '../../shared/types.js';

test('project creation commits one project, issue sequence and actor activity across retry and restart, and fences stale restores', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'teamspace-project-create-'));
  function start() {
    const runtime = createApp({ dataDir: directory, outboundWorker: false });
    return { runtime, server: runtime.app.listen(0, '127.0.0.1') };
  }
  let service = start();
  const observer = new DatabaseSync(join(directory, 'teamspace.sqlite'));
  async function stop() {
    service.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => service.server.close(error => error ? reject(error) : resolve()));
    service.runtime.close();
  }
  t.after(async () => {
    try { await stop(); }
    finally { observer.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  await once(service.server, 'listening');
  const actor = 'user-seo';
  async function call<T>(path: string, method = 'GET', input?: unknown, actorId = actor) {
    const address = service.server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api${path}`, {
      method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actorId },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    return { status: response.status, data: await response.json() as T };
  }
  type ErrorBody = { details: { reason: string } };
  const generation = (await call<WorkspaceSnapshot>('/workspace')).data.restoreGeneration;
  const input = { name: '합성 새 프로젝트', key: 'FIRSTDAY2026', description: '합성 설명', requestId: randomUUID(), restoreGeneration: generation };
  assert.equal((await call<ErrorBody>('/projects', 'POST', { ...input, requestId: 'malformed' })).data.details.reason, 'invalid_request');
  const reordered = { requestId: input.requestId.toUpperCase(), restoreGeneration: generation, description: input.description, key: input.key, name: input.name };

  observer.exec("CREATE TRIGGER fail_project_creation_receipt BEFORE INSERT ON project_creation_requests BEGIN SELECT RAISE(ABORT,'synthetic project creation receipt failure'); END");
  try { assert.equal((await call('/projects', 'POST', input)).status, 500); }
  finally { observer.exec('DROP TRIGGER fail_project_creation_receipt'); }
  assert.equal(observer.prepare('SELECT 1 FROM projects WHERE key=?').get(input.key), undefined);
  assert.equal(observer.prepare('SELECT 1 FROM activities WHERE json_extract(json,\'$.detail\')=?').get(input.name), undefined);

  const [one, two] = await Promise.all([call<Project>('/projects', 'POST', input), call<Project>('/projects', 'POST', reordered)]);
  assert.deepEqual([one.status, two.status].sort(), [200, 201]);
  const project = one.data;
  assert.deepEqual(two.data, project);
  const { data: snapshot } = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(snapshot.projects.filter(value => value.key === input.key), [project]);
  const activity = snapshot.activities.filter(value => value.resourceId === project.id);
  assert.equal(activity.length, 1);
  assert.equal(activity[0].actorId, actor);
  const duplicateKey = await call<ErrorBody>('/projects', 'POST', { ...input, requestId: randomUUID(), key: input.key.toLowerCase() });
  assert.equal(duplicateKey.status, 409);
  assert.equal(duplicateKey.data.details.reason, 'duplicate_key');
  assert.equal((await call<ErrorBody>('/projects', 'POST', { ...input, name: '다른 입력' })).data.details.reason, 'request_conflict');
  assert.equal((await call<ErrorBody>('/projects', 'POST', input, 'user-min')).data.details.reason, 'request_conflict');
  const issue = await call<Issue>('/issues', 'POST', { projectId: project.id, title: '첫 번째 합성 업무' });
  assert.equal(issue.status, 201);
  assert.equal(issue.data.key, `${project.key}-1`);

  await stop();
  service = start();
  await once(service.server, 'listening');
  assert.deepEqual(await call<Project>('/projects', 'POST', input), { status: 200, data: project });
  const { data: backup } = await call('/export');
  assert.equal((await call('/import', 'POST', { data: backup })).status, 200);
  assert.equal((await call<ErrorBody>('/projects', 'POST', input)).data.details.reason, 'workspace_changed');
  const restored = (await call<WorkspaceSnapshot>('/workspace')).data;
  assert.notEqual(restored.restoreGeneration, generation);
  const noGeneration = { name: '복원으로 무효화한 요청', key: 'RTRY', requestId: randomUUID() };
  assert.equal((await call('/projects', 'POST', noGeneration)).status, 201);
  assert.equal((await call('/import', 'POST', { data: backup })).status, 200);
  assert.equal((await call<ErrorBody>('/projects', 'POST', noGeneration)).data.details.reason, 'result_unavailable');
  assert.equal((await call<WorkspaceSnapshot>('/workspace')).data.projects.some(value => value.key === noGeneration.key), false);
});
