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
import type { ApiKeyCreated, ApiKeyRecord, Comment, DocPage, Issue, PlanningItem, Project, User, WorkspaceSnapshot } from '../../shared/types.js';

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
