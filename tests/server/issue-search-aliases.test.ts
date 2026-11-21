import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { IssueProjectMoveInput, IssueProjectMovePreview, IssueProjectMoveResult } from '../../shared/issue-project-move.js';
import type { ApiKeyCreated, Issue, IssueKeyMatch, LegacyPackageSummary, MigrationApplyResult, MigrationOptions, MigrationPreview,
  Project, WorkspaceSnapshot } from '../../shared/types.js';

async function open(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teamspace-issue-aliases-'));
  const runtime = createApp({ dataDir: directory, outboundWorker: false, recurringIssueWorker: false, deadlineReminderWorker: false });
  const server = runtime.app.listen(0, '127.0.0.1');
  const database = new DatabaseSync(join(directory, 'teamspace.sqlite'));
  t.after(async () => {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    database.close();
    runtime.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const apiUrl = `http://127.0.0.1:${address.port}/api`;
  async function call<T = unknown>(path: string, options: {
    method?: string; body?: unknown; status?: number; headers?: Record<string, string>;
  } = {}): Promise<T> {
    const { method = 'GET', body, status = 200, headers } = options;
    const response = await fetch(`${apiUrl}${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const raw = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${raw.slice(0, 1000)}`);
    return JSON.parse(raw) as T;
  }
  const project = (key: string, name: string) => call<Project>('/projects', { method: 'POST', status: 201, body: { key, name } });
  const issue = (target: Project, title: string, fields: Partial<Pick<Issue, 'description' | 'labels'>> = {}) =>
    call<Issue>('/issues', { method: 'POST', status: 201, body: { projectId: target.id, title, ...fields } });
  const snapshot = () => call<WorkspaceSnapshot>('/workspace');
  const conditionalSnapshot = (revision?: string) => fetch(`${apiUrl}/workspace${revision ? `?teamBoardSince=${encodeURIComponent(revision)}` : ''}`);
  const findKey = (key: string, projectId?: string, token?: string, status = 200) => {
    const params = new URLSearchParams(projectId ? { key, projectId } : { key });
    return call<IssueKeyMatch[]>(`${token ? '/v1' : ''}/issue-key-matches?${params}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined, status,
    });
  };
  async function migrate(instanceKey: string, jiraKey: string, targetKey: string, title: string) {
    const csv = [
      'Issue id,Issue key,Project key,Summary,Created,Updated,Status,Issue Type',
      `100,${jiraKey},${jiraKey.split('-')[0]},${title},2020-01-01T00:00:00Z,2020-01-02T00:00:00Z,Open,Task`,
    ].join('\r\n');
    const query = new URLSearchParams({ filename: `${instanceKey}.csv`, product: 'jira', instanceKey });
    const staged = await call<LegacyPackageSummary>(`/legacy-import/packages?${query}`, {
      method: 'POST', status: 201, body: csv, headers: { 'Content-Type': 'application/octet-stream' },
    });
    const { defaultConfiguration: configuration } = await call<MigrationOptions>(`/migrations/options?packageId=${staged.id}`);
    configuration.projects = configuration.projects.map(value => ({ ...value, key: targetKey }));
    const preview = await call<MigrationPreview>('/migrations/preview', { method: 'POST', status: 201, body: { configuration } });
    assert.ok(preview.canApply, JSON.stringify(preview.notices));
    const applied = await call<MigrationApplyResult>(`/migrations/previews/${preview.id}/apply`, {
      method: 'POST', status: 201, body: { expectedVersion: preview.version, acknowledgements: preview.requiredAcknowledgements },
    });
    const [projectId] = applied.import.projectIds;
    const workspace = await snapshot();
    const row = workspace.issues.find(value => value.projectId === projectId && value.title === title);
    assert.ok(row);
    return row;
  }
  async function move(before: Issue, target: Project) {
    const path = `/issues/${before.id}/project-move`;
    const input: IssueProjectMoveInput = { expectedVersion: before.version, projectId: target.id, includeConnected: false, mappings: [] };
    const preview = await call<IssueProjectMovePreview>(`${path}/preview`, { method: 'POST', body: input });
    assert.ok(preview.token, JSON.stringify(preview.blockers));
    const { issues } = await call<IssueProjectMoveResult>(`${path}/apply`, { method: 'POST', body: { ...input, token: preview.token } });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].id, before.id);
    return issues[0];
  }
  async function readToken(projectId: string) {
    return (await call<ApiKeyCreated>('/api-keys', { method: 'POST', status: 201,
      body: { access: 'read', name: `합성 키 ${projectId}`, projectIds: [projectId] } })).token;
  }
  return { call, database, project, issue, snapshot, conditionalSnapshot, findKey, migrate, move, readToken };
}

test('migrated Jira keys resolve through proved aliases without hiding colliding current keys or crossing API key scopes', async t => {
  const f = await open(t);
  const project = await f.project('ALNOW', '현재 업무 프로젝트');
  const current = await f.issue(project, '현재 번호의 업무');
  const first = await f.migrate('alias-jira-one', current.key, 'ALJIRA1', '첫 Jira 원본 업무');
  const second = await f.migrate('alias-jira-two', current.key, 'ALJIRA2', '둘째 Jira 원본 업무');
  const unrelated = await f.issue(project, '본문에만 번호가 등장하는 업무', { description: 'UNBOUND-7', labels: ['UNBOUND-7'] });
  await f.call('/comments', { method: 'POST', status: 201, body: { resourceType: 'issue', resourceId: unrelated.id, body: 'UNBOUND-7' } });

  const snapshot = await f.snapshot();
  const alias = { key: current.key, source: 'jira' };
  assert.deepEqual(snapshot.issueAliases?.[first.id], [alias]);
  assert.deepEqual(snapshot.issueAliases?.[second.id], [alias]);
  assert.equal(snapshot.issueAliases?.[current.id], undefined);
  assert.equal(snapshot.issueAliases?.[unrelated.id], undefined);
  assert.deepEqual(await f.findKey('UNBOUND-7'), []);
  const wideKey = [...current.key.toLowerCase()].map(char => String.fromCharCode(char.charCodeAt(0) + 0xfee0)).join('');
  const results = await f.findKey(`  ${wideKey}  `);
  assert.deepEqual(results[0], { issue: current, matchedAliases: [] });
  assert.deepEqual(new Set(results.slice(1).map(value => value.issue.id)), new Set([first.id, second.id]));
  for (const result of results.slice(1)) assert.deepEqual(result.matchedAliases, [alias]);
  const firstToken = await f.readToken(first.projectId);
  const currentToken = await f.readToken(current.projectId);
  assert.deepEqual(await f.findKey(current.key, undefined, firstToken), [{ issue: first, matchedAliases: [alias] }]);
  assert.deepEqual(await f.findKey(current.key, first.projectId, firstToken), [{ issue: first, matchedAliases: [alias] }]);
  await f.findKey(current.key, second.projectId, firstToken, 403);
  assert.deepEqual(await f.findKey(current.key, undefined, currentToken), [{ issue: current, matchedAliases: [] }]);
  for (const query of ['', '?key=', '?key=a&key=b', '?key=a&extra=b']) await f.call(`/issue-key-matches${query}`, { status: 400 });
  const legacy = await f.call<{ issues: Issue[] }>(`/search?${new URLSearchParams({ q: current.key.toLowerCase() })}`);
  assert.deepEqual(new Set(legacy.issues.map(issue => issue.id)), new Set([first.id, second.id, current.id]));

  const before = await f.conditionalSnapshot();
  assert.equal(before.status, 200);
  const revision = before.headers.get('X-Teamspace-Board-Revision');
  assert.ok(revision);
  await before.body?.cancel();
  assert.equal((await f.conditionalSnapshot(revision)).status, 204);
  const unrelatedArchive = f.database.prepare(`INSERT INTO source_records (id,import_id,kind,source_instance,product,source_id,json)
    SELECT 'alias-test-unrelated',import_id,'comment',source_instance,product,'alias-test-unrelated','{}'
    FROM source_records WHERE product='jira' AND kind='issue' AND target_id=? LIMIT 1`).run(first.id);
  assert.equal(unrelatedArchive.changes, 1);
  assert.equal((await f.conditionalSnapshot(revision)).status, 204);
  f.database.prepare('DELETE FROM source_records WHERE id=?').run('alias-test-unrelated');
  const deactivated = f.database.prepare(`DELETE FROM source_bindings WHERE product='jira' AND kind='issue' AND source_alias=? AND target_id=?`)
    .run(current.key, first.id);
  assert.equal(deactivated.changes, 1);
  const refreshed = await f.conditionalSnapshot(revision);
  assert.equal(refreshed.status, 200);
  assert.notEqual(refreshed.headers.get('X-Teamspace-Board-Revision'), revision);
  const refreshedSnapshot = await refreshed.json() as WorkspaceSnapshot;
  assert.equal(refreshedSnapshot.issueAliases?.[first.id], undefined);
  assert.deepEqual(refreshedSnapshot.issueAliases?.[second.id], [alias]);
  assert.deepEqual((await f.findKey(current.key)).map(value => value.issue.id), [current.id, second.id]);
  f.database.prepare(`INSERT INTO source_bindings(product,source_instance,kind,source_alias,target_type,target_id,import_id)
    SELECT product,source_instance,kind,'UNPROVED-9',target_type,target_id,import_id FROM source_bindings
    WHERE product='jira' AND kind='issue' AND source_alias=? AND target_id=?`).run(current.key, second.id);
  assert.deepEqual(await f.findKey('UNPROVED-9'), []);
  const { trashEntryId } = await f.call<{ trashEntryId: string }>(`/issues/${second.id}?expectedVersion=${second.version}`, { method: 'DELETE' });
  assert.ok(trashEntryId);
  assert.equal((await f.snapshot()).issueAliases?.[second.id], undefined);
  assert.deepEqual(await f.findKey(current.key), [{ issue: current, matchedAliases: [] }]);
});

test('past native issue keys follow later project moves and are derived again after portable restore', async t => {
  const source = await open(t);
  const restored = await open(t);
  const from = await source.project('ALFROM', '이전 번호 프로젝트');
  const via = await source.project('ALVIA', '중간 이동 프로젝트');
  const to = await source.project('ALTO', '최신 업무 프로젝트');
  const created = await source.issue(from, '두 번 이동하는 업무');
  const interim = await source.move(created, via);
  const final = await source.move(interim, to);
  const migrated = await source.migrate('alias-jira-portable', created.key, 'ALHIST', '이동 전 번호와 겹치는 Jira 업무');
  const backup = await source.call<Record<string, unknown>>('/export');
  assert.equal(Object.hasOwn(backup, 'issueAliases'), false);
  await restored.call('/import', { method: 'POST', body: { data: backup } });

  for (const f of [source, restored]) {
    const snapshot = await f.snapshot();
    assert.deepEqual(new Set(snapshot.issueAliases?.[final.id]), new Set([
      { key: created.key, source: 'move' }, { key: interim.key, source: 'move' },
    ]));
    assert.deepEqual(snapshot.issueAliases?.[migrated.id], [{ key: created.key, source: 'jira' }]);
    const collision = await f.findKey(created.key);
    assert.deepEqual(new Set(collision.map(value => [value.issue.id, value.matchedAliases])), new Set([
      [final.id, [{ key: created.key, source: 'move' }]],
      [migrated.id, [{ key: created.key, source: 'jira' }]],
    ]));
    const oldScope = await f.readToken(from.id);
    const currentScope = await f.readToken(to.id);
    for (const key of [created.key, interim.key]) {
      const [result] = await f.findKey(key, to.id, currentScope);
      assert.equal(result?.issue.id, final.id);
      assert.equal(result.issue.key, final.key);
      assert.deepEqual(result.matchedAliases, [{ key, source: 'move' }]);
      assert.deepEqual(await f.findKey(key, from.id), []);
      assert.deepEqual(await f.findKey(key, undefined, oldScope), []);
    }
    assert.deepEqual((await f.findKey(final.key)).map(value => [value.issue.id, value.matchedAliases]), [[final.id, []]]);
  }
});
