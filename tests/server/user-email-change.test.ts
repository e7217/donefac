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
import type { ApiKeyCreated, Project, User, UserEmailChangeResult, WorkspaceSnapshot } from '../../shared/types.js';

test('member email compare-and-set and durable recovery preserve the member and key without overwriting a later change', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'teamspace-member-email-'));
  function start() {
    const runtime = createApp({ dataDir: directory, outboundWorker: false });
    return { runtime, server: runtime.app.listen(0, '127.0.0.1') };
  }
  let service = start();
  const observer = new DatabaseSync(join(directory, 'teamspace.sqlite'));
  async function stop() {
    service.server.closeAllConnections();
    await new Promise<void>(resolve => service.server.close(() => resolve()));
    service.runtime.close();
  }
  t.after(async () => {
    try { await stop(); }
    finally { observer.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  await once(service.server, 'listening');
  const actor = 'user-seo', memberId = 'user-min', memberPath = `/users/${memberId}`;
  async function call<T>(path: string, method = 'GET', data?: unknown, headers: Record<string, string> = { 'X-Actor-Id': actor }) {
    const { port } = service.server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, data: await response.json() as T };
  }
  const initial = (await call<WorkspaceSnapshot>('/workspace')).data;
  const original = initial.users.find(user => user.id === memberId)!;
  const oldVersion = original.version ?? 1;
  const input = { email: 'member-after@example.test', expectedVersion: oldVersion,
    requestId: randomUUID(), restoreGeneration: initial.restoreGeneration };
  const changes = (snapshot: WorkspaceSnapshot) => snapshot.activities.filter(value => value.resourceType === 'user' && value.resourceId === memberId);
  const key = await call<ApiKeyCreated>('/api-keys', 'POST', { name: '합성 키', access: 'read', projectIds: [initial.projects[0].id], expiresAt: null }, { 'X-Actor-Id': memberId });
  assert.equal(key.status, 201);
  type Rejected = { details: { reason: string; currentUser?: User } };
  assert.equal((await call(memberPath, 'PATCH', input, {})).status, 400);
  assert.equal((await call<Rejected>(memberPath, 'PATCH', { ...input, expectedVersion: undefined })).data.details.reason, 'invalid_request');

  observer.exec("CREATE TRIGGER fail_member_email_receipt BEFORE INSERT ON user_email_change_requests BEGIN SELECT RAISE(ABORT,'synthetic member email receipt failure'); END");
  try { assert.equal((await call(memberPath, 'PATCH', input)).status, 500); }
  finally { observer.exec('DROP TRIGGER fail_member_email_receipt'); }
  const afterRollback = (await call<WorkspaceSnapshot>('/workspace')).data;
  assert.deepEqual(afterRollback.users.find(user => user.id === memberId), original);
  assert.deepEqual(changes(afterRollback), changes(initial));

  const [first, again] = await Promise.all([
    call<UserEmailChangeResult>(memberPath, 'PATCH', input),
    call<UserEmailChangeResult>(memberPath, 'PATCH', { ...input, email: input.email.toUpperCase(), requestId: input.requestId.toUpperCase() }),
  ]);
  assert.deepEqual([first.status, again.status], [200, 200]);
  assert.deepEqual([first.data.duplicate, again.data.duplicate].sort(), [false, true]);
  const updated = { ...original, email: input.email, version: oldVersion + 1 };
  for (const result of [first, again]) {
    assert.equal(result.data.appliedVersion, updated.version);
    assert.deepEqual(result.data.user, updated);
  }
  const withEmail = (await call<WorkspaceSnapshot>('/workspace')).data;
  assert.deepEqual(changes(withEmail).filter(value => !changes(initial).some(old => old.id === value.id)).map(value => value.actorId), [actor]);
  const projects = await call<Project[]>('/v1/projects', 'GET', undefined, { Authorization: `Bearer ${key.data.token}` });
  assert.equal(projects.status, 200);
  assert.deepEqual(projects.data.map(project => project.id), [initial.projects[0].id]);

  assert.equal((await call<Rejected>(memberPath, 'PATCH', { ...input, email: 'different@example.test' })).data.details.reason, 'request_conflict');
  assert.equal((await call<Rejected>(memberPath, 'PATCH', input, { 'X-Actor-Id': memberId })).data.details.reason, 'request_conflict');
  assert.equal((await call<Rejected>(`/users/${actor}`, 'PATCH', input)).data.details.reason, 'request_conflict');
  const legacy = await call<User>(memberPath, 'PATCH', { email: original.email, version: oldVersion });
  assert.equal(legacy.status, 200);
  assert.deepEqual(legacy.data, { ...original, version: oldVersion + 2 });
  const stale = await call<Rejected>(memberPath, 'PATCH', { ...input, requestId: randomUUID() });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.data.details, { reason: 'member_changed', currentUser: legacy.data });

  await stop();
  service = start();
  await once(service.server, 'listening');
  const replay = await call<UserEmailChangeResult>(memberPath, 'PATCH', input);
  assert.deepEqual(replay, { status: 200, data: { user: legacy.data, appliedVersion: updated.version, duplicate: true } });
  assert.equal(changes((await call<WorkspaceSnapshot>('/workspace')).data).length, changes(initial).length + 2);
  const { data: backup } = await call('/export');
  assert.equal((await call('/import', 'POST', { data: backup })).status, 200);
  assert.equal((await call<Rejected>(memberPath, 'PATCH', input)).data.details.reason, 'workspace_changed');
  const restored = (await call<WorkspaceSnapshot>('/workspace')).data;
  assert.deepEqual(restored.users.find(user => user.id === memberId), legacy.data);
  const afterRestore = await call<UserEmailChangeResult>(memberPath, 'PATCH', { ...input, requestId: randomUUID(),
    expectedVersion: legacy.data.version, restoreGeneration: restored.restoreGeneration });
  assert.equal(afterRestore.status, 200);
  assert.deepEqual(afterRestore.data.user, { ...original, email: input.email, version: oldVersion + 3 });
});
