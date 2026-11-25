import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../../server/app.js';
import { ApiKeyService } from '../../server/api-keys.js';
import type { ApiKeyCreated, ApiKeyIssuanceResult, ApiKeyRecord, AttachmentHead, AttachmentVersion, Comment, Dependency, DocPage, Issue, IssueRelation, PlanningItem, Project, User, WorkspaceSnapshot } from '../../shared/types.js';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'teamspace-api-key-test-'));
  const service = createApp({ dataDir: dir });
  const server = service.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test server');
  const base = `http://127.0.0.1:${address.port}`;
  const call = async <T = unknown>(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as T };
  };
  const create = async (access: 'read' | 'write' = 'read', projectIds: string[] | null = ['project-neo'], owner = 'user-min') => {
    const result = await call<ApiKeyCreated>('/api-keys', 'POST', { name: '합성 자동화 키', access, projectIds, expiresAt: null }, { 'X-Actor-Id': owner });
    assert.equal(result.status, 201); return result.data as ApiKeyCreated;
  };
  return { dir, base, call, create, close: async () => { service.close(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); } };
}
const bearer = (token: string, extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${token}`, ...extra });

test('API keys store hashes only, list owner metadata, revoke by CAS and reject expired/invalid credentials', async () => {
  const f = await fixture(); const database = new DatabaseSync(join(f.dir, 'teamspace.sqlite'));
  try {
    const created = await f.create();
    assert.match(created.token, /^ts_[A-Za-z0-9_-]{43}$/);
    const row = database.prepare('SELECT token_hash,json FROM api_keys WHERE id=?').get(created.key.id) as { token_hash: string; json: string };
    assert.equal(row.token_hash, createHash('sha256').update(created.token).digest('hex'));
    assert.equal(row.json.includes(created.token), false);
    const list = await f.call<ApiKeyRecord[]>('/api-keys', 'GET', undefined, { 'X-Actor-Id': 'user-min' });
    assert.equal(list.data.length, 1); assert.equal('token' in list.data[0], false); assert.equal('token_hash' in list.data[0], false);
    assert.equal((await f.call<ApiKeyRecord[]>('/api-keys', 'GET', undefined, { 'X-Actor-Id': 'user-seo' })).data.length, 0);
    assert.equal((await f.call(`/api-keys/${created.key.id}/revoke`, 'POST', { expectedVersion: 1 }, { 'X-Actor-Id': 'user-seo' })).status, 404);
    assert.equal((await f.call(`/api-keys/${created.key.id}/revoke`, 'POST', { expectedVersion: 9 })).status, 409);
    assert.equal((await f.call<Project[]>('/v1/projects', 'GET', undefined, bearer(created.token))).status, 200);
    const used = (await f.call<ApiKeyRecord[]>('/api-keys')).data[0]; assert.ok(used.lastUsedAt); assert.equal(used.version, 1);
    assert.equal((await f.call(`/api-keys/${created.key.id}/revoke`, 'POST', { expectedVersion: 1 })).status, 200);
    assert.equal((await f.call<ApiKeyRecord>(`/api-keys/${created.key.id}/revoke`, 'POST', { expectedVersion: 1 })).data.version, 2);
    assert.equal((await f.call(`/api-keys/${created.key.id}/revoke`, 'POST', { expectedVersion: -1 })).status, 400);
    assert.equal((await f.call<Project[]>('/v1/projects', 'GET', undefined, bearer(created.token))).status, 401);
    const expiring = await f.create();
    database.prepare("UPDATE api_keys SET json=json_set(json,'$.expiresAt',?) WHERE id=?").run('2000-01-01T00:00:00.000Z', expiring.key.id);
    assert.equal((await f.call<Project[]>('/v1/projects', 'GET', undefined, bearer(expiring.token))).status, 401);
    for (const authorization of ['', 'Basic abc', 'Bearer missing', 'Bearer ts_' + 'a'.repeat(43)]) assert.equal((await f.call<Project[]>('/v1/projects', 'GET', undefined, authorization ? { Authorization: authorization } : { 'X-Actor-Id': 'user-min' })).status, 401);
    const backup = await f.call<WorkspaceSnapshot>('/export');
    assert.equal(JSON.stringify(backup.data).includes(created.token), false);
    assert.equal(JSON.stringify(backup.data).includes(expiring.token), false);
    assert.equal('apiKeys' in backup.data, false);
  } finally { database.close(); await f.close(); }
});

test('guarded issuance recovers the exact key without returning its secret and fences native restores', async () => {
  const f = await fixture();
  const database = new DatabaseSync(join(f.dir, 'teamspace.sqlite'));
  const owner = { 'X-Actor-Id': 'user-seo' };
  type Refusal = { details: { reason: string } };
  try {
    const snapshot = (await f.call<WorkspaceSnapshot>('/workspace')).data;
    const input = { name: '응답 복구 합성 키', access: 'read', projectIds: snapshot.projects.map(project => project.id),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(), requestId: randomUUID(), restoreGeneration: snapshot.restoreGeneration };
    assert.equal((await f.call('/api-keys', 'POST', input)).status, 400);
    assert.equal((await f.call<Refusal>('/api-keys', 'POST', { ...input, requestId: 'invalid' }, owner)).data.details.reason, 'invalid_request');
    for (const settings of [{ expiresAt: '2000-01-01T00:00:00.000Z' }, { projectIds: ['missing-project'] }]) {
      const invalid = await f.call<Refusal>('/api-keys', 'POST', { ...input, ...settings }, owner);
      assert.equal(invalid.status, 400);
      assert.equal(invalid.data.details.reason, 'invalid_settings');
    }
    database.exec("CREATE TRIGGER reject_key_receipt BEFORE INSERT ON api_key_issuance_requests BEGIN SELECT RAISE(ABORT,'synthetic issuance receipt failure'); END");
    try { assert.equal((await f.call('/api-keys', 'POST', input, owner)).status, 500); }
    finally { database.exec('DROP TRIGGER reject_key_receipt'); }
    assert.deepEqual((await f.call<ApiKeyRecord[]>('/api-keys', 'GET', undefined, owner)).data, []);
    assert.equal((await f.call<WorkspaceSnapshot>('/workspace')).data.activities.some(activity => activity.detail === input.name), false);

    const results = await Promise.all([
      f.call<ApiKeyIssuanceResult>('/api-keys', 'POST', input, owner),
      f.call<ApiKeyIssuanceResult>('/api-keys', 'POST', { ...input, requestId: input.requestId.toUpperCase(), projectIds: input.projectIds.slice().reverse() }, owner),
    ]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 201]);
    const created = results.find(result => result.status === 201)!.data as ApiKeyCreated;
    assert.match(created.token, /^ts_[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(results.find(result => result.status === 200)!.data, { key: created.key, duplicate: true });
    assert.equal((await f.call<WorkspaceSnapshot>('/workspace')).data.activities.filter(activity => activity.resourceId === created.key.id).length, 1);
    const receipt = database.prepare('SELECT * FROM api_key_issuance_requests WHERE id=?').get(input.requestId);
    assert.equal(receipt?.key_id, created.key.id);
    assert.equal(JSON.stringify(receipt).includes(created.token), false);

    for (const [body, headers] of [[{ ...input, name: '다른 설정' }, owner], [input, { 'X-Actor-Id': 'user-min' }]] as const) {
      const result = await f.call<Refusal>('/api-keys', 'POST', body, headers);
      assert.equal(result.status, 409);
      assert.equal(result.data.details.reason, 'request_conflict');
    }
    assert.equal((await f.call<Project[]>('/v1/projects', 'GET', undefined, bearer(created.token))).status, 200);
    const current = (await f.call<ApiKeyRecord[]>('/api-keys', 'GET', undefined, owner)).data[0];
    assert.ok(current.lastUsedAt);
    assert.deepEqual((await f.call('/api-keys', 'POST', input, owner)).data, { key: current, duplicate: true });
    const revokePath = `/api-keys/${created.key.id}/revoke`;
    assert.equal((await f.call<Refusal>(revokePath, 'POST', { expectedVersion: current.version, restoreGeneration: 'obsolete' }, owner)).data.details.reason, 'workspace_changed');
    assert.equal((await f.call(revokePath, 'POST', { expectedVersion: current.version + 1, restoreGeneration: input.restoreGeneration }, owner)).status, 409);
    const revoke = { expectedVersion: current.version, restoreGeneration: input.restoreGeneration };
    const revoked = await f.call<ApiKeyRecord>(revokePath, 'POST', revoke, owner);
    assert.ok(revoked.data.revokedAt);
    assert.deepEqual(await f.call(revokePath, 'POST', revoke, owner), revoked);
    assert.deepEqual((await f.call('/api-keys', 'POST', input, owner)).data, { key: revoked.data, duplicate: true });
    assert.equal((await f.call<Project[]>('/v1/projects', 'GET', undefined, bearer(created.token))).status, 401);

    const replacement = await f.call<ApiKeyCreated>('/api-keys', 'POST', { ...input, requestId: randomUUID() }, owner);
    assert.equal(replacement.status, 201);
    assert.notEqual(replacement.data.key.id, created.key.id);
    assert.notEqual(replacement.data.token, created.token);
    const backup = (await f.call<WorkspaceSnapshot>('/export')).data;
    assert.equal(JSON.stringify(backup).includes(replacement.data.token), false);
    assert.equal((await f.call('/import', 'POST', { data: backup })).status, 200);
    assert.equal(database.prepare('SELECT 1 FROM api_key_issuance_requests').get(), undefined);
    assert.equal((await f.call<Refusal>('/api-keys', 'POST', input, owner)).data.details.reason, 'workspace_changed');
    assert.deepEqual((await f.call<ApiKeyRecord[]>('/api-keys', 'GET', undefined, owner)).data, []);
  } finally { database.close(); await f.close(); }
});

test('read-only public routes enforce project scope, minimal users, supported lookups and strict scalar queries', async () => {
  const f = await fixture();
  try {
    const { token } = await f.create(); const headers = bearer(token);
    const shared = await f.call<DocPage>('/documents', 'POST', { title: '공통 문서', projectId: null });
    const outside = await f.call<DocPage>('/documents', 'POST', { title: '다른 프로젝트 문서', projectId: 'project-team' });
    const outsidePlan = await f.call<PlanningItem>('/planning-items', 'POST', { projectId: 'project-team', kind: 'cycle', name: '다른 프로젝트 사이클' });
    assert.deepEqual((await f.call<Project[]>('/v1/projects', 'GET', undefined, headers)).data.map(project => project.id), ['project-neo']);
    const issues = (await f.call<Issue[]>('/v1/issues', 'GET', undefined, headers)).data; assert.ok(issues.length); assert.ok(issues.every(issue => issue.projectId === 'project-neo'));
    const docs = (await f.call<DocPage[]>('/v1/documents', 'GET', undefined, headers)).data; assert.ok(docs.every(document => document.projectId === 'project-neo'));
    for (const path of [`/v1/documents/${shared.data.id}`, `/v1/documents/${outside.data.id}`, '/v1/projects/project-team/workflow', `/v1/planning-items/${outsidePlan.data.id}`, '/v1/issues?projectId=project-team']) assert.equal((await f.call(path, 'GET', undefined, headers)).status, 403);
    assert.equal((await f.call(`/v1/issues/${issues[0].id}`, 'GET', undefined, headers)).status, 200);
    assert.equal((await f.call('/v1/projects/project-neo/workflow', 'GET', undefined, headers)).status, 200);
    assert.equal((await f.call('/v1/planning-items?projectId=project-neo&kind=cycle', 'GET', undefined, headers)).status, 200);
    const users = (await f.call<Pick<User, 'id' | 'name' | 'color'>[]>('/v1/users', 'GET', undefined, headers)).data;
    assert.ok(users.length); assert.deepEqual(Object.keys(users[0]).sort(), ['color', 'id', 'name']);
    for (const path of ['/v1/workspace', '/v1/export', '/v1/api-keys', '/v1/integrations/gitlab', '/v1/documents/doc-overview/collaboration', '/v1/search', '/v1/unknown']) assert.equal((await f.call(path, 'GET', undefined, headers)).status, 403);
    for (const path of ['/v1/issues?projectId=project-neo&projectId=project-team', '/v1/issues?projectId[]=project-neo', '/v1/planning-items?kind=cycle&kind=module', '/v1/comments?resourceType=issue&resourceId=issue-1&resourceId=issue-2']) assert.equal((await f.call(path, 'GET', undefined, headers)).status, 400);
    assert.equal((await f.call('/v1/issues', 'POST', { title: '읽기 키의 쓰기', projectId: 'project-neo' }, headers)).status, 403);
    assert.equal((await f.call(`/v1/comments?resourceType=document&resourceId=${outside.data.id}`, 'GET', undefined, headers)).status, 403);
  } finally { await f.close(); }
});

test('public mutations reuse normal validation and bind author, target/source scope, parent and planning references', async () => {
  const f = await fixture();
  try {
    const { token } = await f.create('write', ['project-neo'], 'user-seo'); const headers = bearer(token, { 'X-Actor-Id': 'user-jun' });
    const made = await f.call<DocPage>('/v1/documents', 'POST', { projectId: 'project-neo', title: '키 소유자의 문서', actorId: 'user-jun', authorId: 'user-jun' }, headers);
    assert.equal(made.status, 201); assert.equal(made.data.authorId, 'user-seo');
    const comment = await f.call<Comment>('/v1/comments', 'POST', { resourceType: 'document', resourceId: made.data.id, body: '실제 소유자', authorId: 'user-jun', actorId: 'user-jun' }, headers);
    assert.equal(comment.status, 201); assert.equal(comment.data.authorId, 'user-seo');
    assert.equal((await f.call<DocPage>('/v1/documents', 'POST', { title: '공통 문서 쓰기', projectId: null }, headers)).status, 403);
    const outside = await f.call<DocPage>('/documents', 'POST', { title: '다른 프로젝트', projectId: 'project-team' });
    assert.equal((await f.call<DocPage>('/v1/documents', 'POST', { title: '부모 우회', projectId: 'project-neo', parentId: outside.data.id }, headers)).status, 403);
    assert.equal((await f.call(`/v1/documents/${outside.data.id}`, 'PATCH', { title: '소스 우회', expectedVersion: 1, projectId: 'project-neo' }, headers)).status, 403);
    assert.equal((await f.call(`/v1/documents/${made.data.id}`, 'PATCH', { expectedVersion: 1, projectId: 'project-team' }, headers)).status, 403);
    const plan = await f.call<PlanningItem>('/planning-items', 'POST', { projectId: 'project-team', kind: 'cycle', name: '외부 계획' });
    assert.equal((await f.call('/v1/issues', 'POST', { title: '계획 우회', projectId: 'project-neo', cycleId: plan.data.id }, headers)).status, 403);
    assert.equal((await f.call('/v1/issues', 'POST', { title: '부모 우회', projectId: 'project-neo', parentId: 'issue-10' }, headers)).status, 403);
    assert.equal((await f.call(`/v1/documents/${made.data.id}`, 'PATCH', { title: '버전 누락' }, headers)).status, 400);
    assert.equal((await f.call(`/v1/documents/${made.data.id}`, 'PATCH', { title: '수정', expectedVersion: 1 }, headers)).status, 200);
    assert.equal((await f.call(`/v1/documents/${made.data.id}`, 'PATCH', { title: '오래된 수정', expectedVersion: 1 }, headers)).status, 409);
    for (const path of [`/v1/documents/${made.data.id}`, `/v1/documents/${made.data.id}?expectedVersion=NaN`, `/v1/documents/${made.data.id}?expectedVersion=2&expectedVersion=2`]) assert.equal((await f.call(path, 'DELETE', undefined, headers)).status, 400);
    assert.equal((await f.call(`/v1/documents/${made.data.id}?expectedVersion=1`, 'DELETE', undefined, headers)).status, 409);
    assert.equal((await f.call(`/v1/documents/${made.data.id}?expectedVersion=2`, 'DELETE', undefined, headers)).status, 200);
    assert.equal((await f.call('/v1/planning-items', 'POST', { projectId: 'project-neo', kind: 'cycle', name: '허용하지 않은 생성' }, headers)).status, 403);
    assert.equal((await f.call('/v1/import', 'POST', { data: {} }, headers)).status, 403);
    const wide = await f.create('write', null); assert.equal((await f.call<DocPage>('/v1/documents', 'POST', { title: '전체 범위 공통 문서' }, bearer(wide.token))).status, 201);
  } finally { await f.close(); }
});

test('public schedule dependencies authorize both endpoints and return only the requested project', async () => {
  const f = await fixture();
  try {
    const reader = bearer((await f.create()).token);
    const writer = bearer((await f.create('write')).token);
    const teamWriter = bearer((await f.create('write', ['project-team'])).token);
    const allProjects = bearer((await f.create('read', null)).token);
    const list = '/v1/projects/project-neo/dependencies';
    const outsideList = '/v1/projects/project-team/dependencies';
    const path = '/v1/dependencies';
    const proposed = { predecessorId: 'issue-1', successorId: 'issue-3' };
    assert.equal((await f.call(list, 'GET', undefined, { 'X-Actor-Id': 'user-min' })).status, 401);
    assert.equal((await f.call(path, 'POST', proposed)).status, 401);
    assert.equal((await f.call(outsideList, 'GET', undefined, reader)).status, 403);
    assert.equal((await f.call(`${list}?projectId=project-team`, 'GET', undefined, reader)).status, 400);
    assert.equal((await f.call('/v1/projects/missing-project/dependencies', 'GET', undefined, allProjects)).status, 404);

    // Seed a mixed-project historical row directly so the read and edit guards
    // must check the stored endpoints even though normal creation forbids it.
    const mixed: Dependency = { id: 'mixed-dependency', predecessorId: 'issue-1', successorId: 'issue-10', type: 'FS', lagDays: 0, version: 1 };
    const database = new DatabaseSync(join(f.dir, 'teamspace.sqlite'));
    try {
      database.prepare('INSERT INTO dependencies(id,predecessor_id,successor_id,json) VALUES(?,?,?,?)')
        .run(mixed.id, mixed.predecessorId, mixed.successorId, JSON.stringify(mixed));
    } finally { database.close(); }

    const original = (await f.call<WorkspaceSnapshot>('/workspace')).data;
    const neo = await f.call<Dependency[]>(list, 'GET', undefined, reader);
    assert.equal(neo.status, 200);
    assert.deepEqual(neo.data, [{ id: 'dep-1', predecessorId: 'issue-2', successorId: 'issue-6', type: 'FS', lagDays: 0, version: 1 }]);
    const team = await f.call<Dependency[]>(outsideList, 'GET', undefined, allProjects);
    assert.equal(team.status, 200);
    assert.deepEqual(team.data, [{ id: 'dep-2', predecessorId: 'issue-10', successorId: 'issue-12', type: 'FS', lagDays: 0, version: 1 }]);
    assert.equal((await f.call(path, 'POST', proposed, reader)).status, 403);
    assert.equal((await f.call(`${path}/dep-1`, 'PATCH', { expectedVersion: 1, reverse: true }, reader)).status, 403);
    assert.equal((await f.call(`${path}/dep-1?expectedVersion=1`, 'DELETE', undefined, reader)).status, 403);
    for (const candidate of [
      { ...proposed, predecessorId: 'issue-10' },
      { ...proposed, successorId: 'issue-10' },
    ]) assert.equal((await f.call(path, 'POST', candidate, writer)).status, 403);
    for (const [id, headers] of [['dep-2', writer], [mixed.id, writer], [mixed.id, teamWriter]] as const) {
      assert.equal((await f.call(`${path}/${id}`, 'PATCH', { expectedVersion: 1, reverse: true }, headers)).status, 403);
      assert.equal((await f.call(`${path}/${id}?expectedVersion=1`, 'DELETE', undefined, headers)).status, 403);
    }
    const after = (await f.call<WorkspaceSnapshot>('/workspace')).data;
    assert.deepEqual(after.dependencies, original.dependencies);
    assert.deepEqual(after.activities, original.activities);
  } finally { await f.close(); }
});

test('public schedule dependency edits preserve the graph on cycles and stale versions', async () => {
  const f = await fixture();
  try {
    const writer = bearer((await f.create('write', ['project-neo'], 'user-seo')).token, { 'X-Actor-Id': 'user-jun' });
    const path = '/v1/dependencies';
    async function connect(predecessorId: string, successorId: string) {
      const saved = await f.call<Dependency>(path, 'POST', { predecessorId, successorId, actorId: 'user-jun' }, writer);
      assert.equal(saved.status, 201);
      assert.equal(saved.data.version, 1);
      return saved.data;
    }
    const main = await connect('issue-1', 'issue-4');
    await connect('issue-1', 'issue-3');
    const lastLeg = await connect('issue-3', 'issue-4');
    const changePath = `${path}/${main.id}`;
    const reverse = { expectedVersion: main.version, reverse: true, type: 'SS', lagDays: -2, actorId: 'user-jun' };
    const beforeCycle = (await f.call<WorkspaceSnapshot>('/workspace')).data;
    assert.equal((await f.call(path, 'POST', { predecessorId: 'issue-4', successorId: 'issue-1' }, writer)).status, 400);
    assert.equal((await f.call(changePath, 'PATCH', reverse, writer)).status, 400);
    assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).data, beforeCycle);

    assert.equal((await f.call(`${path}/${lastLeg.id}?expectedVersion=${lastLeg.version}`, 'DELETE', undefined, writer)).status, 200);
    const updated = await f.call<Dependency>(changePath, 'PATCH', reverse, writer);
    assert.equal(updated.status, 200);
    const version = updated.data.version;
    assert.ok(version && main.version && version > main.version);
    assert.deepEqual(updated.data, { id: main.id, predecessorId: 'issue-4', successorId: 'issue-1', type: 'SS', lagDays: -2, version });
    const beforeStale = (await f.call<WorkspaceSnapshot>('/workspace')).data;
    const reversalEvents = beforeStale.activities.filter(entry => entry.action === '선후행 방향 변경');
    assert.deepEqual(reversalEvents.map(({ resourceId }) => resourceId).sort(), ['issue-1', 'issue-4']);
    assert.ok(reversalEvents.every(({ actorId }) => actorId === 'user-seo'));
    assert.equal((await f.call(changePath, 'PATCH', { ...reverse, expectedVersion: undefined }, writer)).status, 400);
    assert.equal((await f.call(changePath, 'PATCH', reverse, writer)).status, 409);
    assert.equal((await f.call(changePath, 'DELETE', undefined, writer)).status, 400);
    assert.equal((await f.call(changePath, 'DELETE', { expectedVersion: version }, writer)).status, 400);
    assert.equal((await f.call(`${changePath}?expectedVersion=${version}`, 'DELETE', { expectedVersion: version }, writer)).status, 400);
    assert.equal((await f.call(`${changePath}?expectedVersion=${version}&expectedVersion=${main.version}`, 'DELETE', undefined, writer)).status, 400);
    assert.equal((await f.call(`${changePath}?expectedVersion=${main.version}`, 'DELETE', undefined, writer)).status, 409);
    assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).data, beforeStale);

    const removed = await f.call(`${changePath}?expectedVersion=${version}`, 'DELETE', undefined, writer);
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.data, { ok: true });
    const list = await f.call<Dependency[]>('/v1/projects/project-neo/dependencies', 'GET', undefined, writer);
    assert.equal(list.status, 200);
    assert.ok(list.data.every(edge => edge.id !== main.id));
  } finally { await f.close(); }
});

test('public conversion authorizes the actual blocking relation and attributes the audit to the key owner', async () => {
  const f = await fixture();
  try {
    const reader = bearer((await f.create()).token);
    const writer = bearer((await f.create('write', ['project-neo'], 'user-seo')).token, { 'X-Actor-Id': 'user-jun' });
    const bothProjects = bearer((await f.create('write', ['project-neo', 'project-team'])).token);
    const relationPath = '/issues/issue-1/relations';
    const local = await f.call<IssueRelation>(relationPath, 'POST', { otherIssueId: 'issue-3', type: 'blocks', direction: 'outgoing' });
    const outside = await f.call<IssueRelation>(relationPath, 'POST', { otherIssueId: 'issue-10', type: 'blocks', direction: 'outgoing' });
    assert.equal(local.status, 201);
    assert.equal(outside.status, 201);
    const path = (issueId: string, relation: IssueRelation) => `/v1/issues/${issueId}/relations/${relation.id}/schedule-dependency`;
    const request = { expectedVersion: local.data.version, predecessorId: 'issue-1', successorId: 'issue-3', type: 'FF', lagDays: 2, actorId: 'user-jun' };
    const localPath = path('issue-1', local.data);
    const outsidePath = path('issue-1', outside.data);
    const before = (await f.call<WorkspaceSnapshot>('/workspace')).data;
    const relationsBefore = (await f.call<IssueRelation[]>(relationPath)).data;
    assert.equal((await f.call(localPath, 'POST', request, reader)).status, 403);
    assert.equal((await f.call(outsidePath, 'POST', request, writer)).status, 403);
    assert.equal((await f.call(localPath, 'POST', { ...request, successorId: 'issue-10' }, writer)).status, 403);
    assert.equal((await f.call(outsidePath, 'POST', { ...request, successorId: 'issue-10' }, bothProjects)).status, 400);
    assert.equal((await f.call(localPath, 'POST', { ...request, successorId: 'issue-4' }, writer)).status, 400);
    assert.equal((await f.call(localPath, 'POST', { ...request, predecessorId: 'issue-3', successorId: 'issue-1' }, writer)).status, 400);
    assert.equal((await f.call(path('issue-4', local.data), 'POST', request, writer)).status, 404);
    assert.equal((await f.call(localPath, 'POST', { ...request, expectedVersion: local.data.version + 1 }, writer)).status, 409);
    assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).data, before);

    const created = await f.call<Dependency>(localPath, 'POST', request, writer);
    assert.equal(created.status, 201);
    assert.deepEqual(created.data, { id: created.data.id, predecessorId: 'issue-1', successorId: 'issue-3', type: 'FF', lagDays: 2, version: 1 });
    const replay = await f.call<Dependency>(path('issue-3', local.data), 'POST', request, writer);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.data, created.data);
    const after = (await f.call<WorkspaceSnapshot>('/workspace')).data;
    assert.deepEqual(after.dependencies, [...before.dependencies, created.data]);
    assert.deepEqual((await f.call<IssueRelation[]>(relationPath)).data, relationsBefore);
    const activityIds = new Set(before.activities.map(entry => entry.id));
    const activities = after.activities.filter(entry => !activityIds.has(entry.id));
    assert.deepEqual(activities.map(({ resourceId, actorId, action }) => ({ resourceId, actorId, action })), [
      { resourceId: 'issue-3', actorId: 'user-seo', action: '선행 업무 연결' },
    ]);
  } finally { await f.close(); }
});

test('scoped keys can upload and read immutable attachment versions within the owning project', async () => {
  const f = await fixture();
  try {
    const writer = await f.create('write', ['project-neo'], 'user-seo');
    const reader = await f.create('read', ['project-neo']);
    const outside = await f.create('write', ['project-team']);
    const document = (await f.call<DocPage>('/documents', 'POST', { projectId:'project-neo',title:'키 범위 첨부 검사' })).data;
    const common = (await f.call<DocPage>('/documents', 'POST', { projectId:null,title:'공통 첨부 검사' })).data;
    const initial = Buffer.from('first immutable attachment version');
    const changed = Buffer.from('second immutable attachment version');
    const file = (resourceId: string) => `/attachments?resourceType=document&resourceId=${resourceId}`;
    const upload = (path: string, token: string, body: Buffer<ArrayBuffer>) => fetch(`${f.base}/api/v1${path}`, {
      method:'POST', body, headers:bearer(token, {'Content-Type':'application/octet-stream','X-Actor-Id':'user-jun'}),
    });
    for (const response of [
      await upload(`${file(document.id)}&filename=report.txt`, reader.token, initial),
      await upload(`${file(common.id)}&filename=report.txt`, writer.token, initial),
    ]) assert.equal(response.status,403,await response.text());
    const uploaded = await upload(`${file(document.id)}&filename=report.txt`,writer.token,initial);
    assert.equal(uploaded.status,201);
    const root = await uploaded.json() as AttachmentHead;
    assert.equal(root.authorId,'user-seo');
    const versionPath = `/attachments/${root.id}/versions`;
    const appendPath = `${versionPath}?expectedVersionId=${root.currentVersionId}&filename=report.txt`;
    assert.equal((await upload(appendPath,reader.token,changed)).status,403);
    assert.equal((await upload(appendPath,outside.token,changed)).status,403);
    assert.equal((await upload(`${appendPath}&expectedVersionId=${root.currentVersionId}`,writer.token,changed)).status,400);
    const appended = await upload(appendPath,writer.token,changed);
    assert.equal(appended.status,201);
    const head = await appended.json() as AttachmentHead;
    assert.equal(head.id,root.id);
    assert.equal(head.authorId,'user-seo');
    assert.notEqual(head.currentVersionId,root.currentVersionId);
    const items = await f.call<AttachmentHead[]>(`/v1${file(document.id)}`,'GET',undefined,bearer(reader.token));
    assert.deepEqual(items.data,[head]);
    const versions = await f.call<AttachmentVersion[]>(`/v1${versionPath}`,'GET',undefined,bearer(reader.token));
    assert.deepEqual(versions.data.map(value=>value.id),[head.currentVersionId,root.id]);
    for (const [path, expected] of [
      [`/attachments/${root.id}/content`,initial],
      [`/attachments/${head.currentVersionId}/content`,changed],
      [`/attachment-versions/${head.currentVersionId}/download`,changed],
    ] as const) {
      const url = `${f.base}/api/v1${path}`;
      const response = await fetch(url,{headers:bearer(reader.token)});
      assert.equal(response.status,200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()),expected);
      assert.equal((await fetch(url,{headers:bearer(outside.token)})).status,403);
      assert.equal((await fetch(url)).status,401);
    }
  } finally { await f.close(); }
});

test('revocation after authentication but before a slow JSON body completes prevents the pending mutation', async t => {
  const f = await fixture(); let slow: ReturnType<typeof httpRequest> | undefined;
  try {
    const { token, key } = await f.create('write');
    let observed = () => {};
    const authenticated = new Promise<void>(resolve => { observed = resolve; });
    const original = ApiKeyService.prototype.authenticate;
    t.mock.method(ApiKeyService.prototype, 'authenticate', function (this: ApiKeyService, value: string) { const record = original.call(this, value); if (record.id === key.id) observed(); return record; });
    const body = JSON.stringify({ projectId: 'project-neo', title: '폐기 뒤 생성되면 안 되는 티켓' });
    const result = new Promise<{ status: number; data: unknown }>((resolve, reject) => {
      slow = httpRequest(f.base + '/api/v1/issues', { method: 'POST', headers: { ...bearer(token), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
        let text = ''; response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode!, data: JSON.parse(text) }));
      });
      slow.on('error', reject); slow.write(body.slice(0, 12));
    });
    await authenticated;
    assert.equal((await f.call(`/api-keys/${key.id}/revoke`, 'POST', { expectedVersion: 1 })).status, 200);
    slow!.end(body.slice(12));
    assert.equal((await result).status, 401);
    assert.equal((await f.call<WorkspaceSnapshot>('/workspace')).data.issues.some(issue => issue.title === '폐기 뒤 생성되면 안 되는 티켓'), false);
  } finally { slow?.destroy(); await f.close(); }
});

test('native import revokes keys atomically: a late rollback preserves them, a successful import removes them', async () => {
  const f = await fixture();
  try {
    const created = await f.create('write', null);
    const backup = (await f.call<WorkspaceSnapshot>('/export')).data;
    const bad = structuredClone(backup);
    bad.resourceLinks.push({ id: randomUUID(), issueId: backup.issues[0].id, documentId: 'missing-after-users-delete', kind: 'related' });
    assert.equal((await f.call('/import', 'POST', { data: bad })).status, 404);
    assert.equal((await f.call<Project[]>('/v1/projects', 'GET', undefined, bearer(created.token))).status, 200);
    assert.equal((await f.call<ApiKeyRecord[]>('/api-keys')).data.length, 1);
    assert.equal((await f.call('/import', 'POST', { data: backup })).status, 200);
    assert.equal((await f.call<Project[]>('/v1/projects', 'GET', undefined, bearer(created.token))).status, 401);
    assert.deepEqual((await f.call<ApiKeyRecord[]>('/api-keys')).data, []);
  } finally { await f.close(); }
});

test('audit failures roll back both key creation and revocation', async () => {
  const f = await fixture(); const database = new DatabaseSync(join(f.dir, 'teamspace.sqlite'));
  try {
    database.exec("CREATE TRIGGER reject_key_audit BEFORE INSERT ON activities WHEN json_extract(NEW.json,'$.resourceType')='api-key' BEGIN SELECT RAISE(FAIL,'synthetic audit rejection'); END;");
    assert.equal((await f.call('/api-keys', 'POST', { name: '감사 실패', access: 'read', projectIds: null, expiresAt: null })).status, 500);
    assert.deepEqual((await f.call<ApiKeyRecord[]>('/api-keys')).data, []);
    database.exec('DROP TRIGGER reject_key_audit');
    const created = await f.create();
    database.exec("CREATE TRIGGER reject_key_audit BEFORE INSERT ON activities WHEN json_extract(NEW.json,'$.resourceType')='api-key' BEGIN SELECT RAISE(FAIL,'synthetic audit rejection'); END;");
    assert.equal((await f.call(`/api-keys/${created.key.id}/revoke`, 'POST', { expectedVersion: 1 })).status, 500);
    assert.equal((await f.call<ApiKeyRecord[]>('/api-keys')).data[0].revokedAt, null);
    assert.equal((await f.call<Project[]>('/v1/projects', 'GET', undefined, bearer(created.token))).status, 200);
  } finally { database.close(); await f.close(); }
});
