import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type { IssueProjectMoveInput, IssueProjectMovePreview, IssueProjectMoveResult } from '../../shared/issue-project-move.js';
import type {
  ApiKeyCreated, GitlabSettings, Issue, IssueReportEvent, LegacyPackageSummary, MigrationApplyResult, MigrationOptions, MigrationPreview,
  Project, SourceRecordArchive, WorkspaceSnapshot,
} from '../../shared/types.js';

const integration = '/integrations/gitlab';
const gitlabBase = 'https://gitlab.example.test';
const secret = `synthetic-move-portable-${randomUUID()}`;
const repository = 423;

async function open(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teamspace-project-move-portable-'));
  const service = createApp({ dataDir: directory, outboundWorker: false });
  const server = service.app.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return async function request<T = unknown>(path: string, status: number | 'ok' = 200, method = 'GET', data?: unknown, headers?: Record<string, string>) {
    const response = await fetch(`http://127.0.0.1:${address.port}/api${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...headers },
      ...(data === undefined ? {} : { body: typeof data === 'string' ? data : JSON.stringify(data) }),
    });
    const body = await response.text();
    const message = `${method} ${path}: ${body.slice(0, 1000)}`;
    if (status === 'ok') assert.ok(response.ok, message);
    else assert.equal(response.status, status, message);
    return JSON.parse(body) as T;
  };
}

async function configureGitlab(request: Awaited<ReturnType<typeof open>>, jiraRoutes: GitlabSettings['jiraRoutes']) {
  const { version } = await request<GitlabSettings>(integration);
  await request(integration, 200, 'PATCH', {
    expectedVersion: version, baseUrl: gitlabBase, projectIds: [repository], webhookSecret: secret, jiraRoutes,
  });
}

function mr(request: Awaited<ReturnType<typeof open>>, oldKey: string, id: number, attributes: Record<string, string> = {}) {
  return request<{ linked: number; duplicate: boolean }>(`${integration}/webhook`, 200, 'POST', {
    object_kind: 'merge_request', project: { id: repository }, object_attributes: {
      id, iid: id, action: 'open', state: 'opened', title: `${oldKey} 이전 업무 키가 있는 새 MR`,
      source_branch: `feature/${oldKey}`, url: `${gitlabBase}/team/repo/-/merge_requests/${id}`, updated_at: new Date().toISOString(), ...attributes,
    },
  }, { 'X-Gitlab-Token': secret, 'webhook-id': randomUUID() });
}

async function importJiraProject(call: Awaited<ReturnType<typeof open>>, instanceKey: string, key: string) {
  const jiraKey = 'ORIG-1';
  const title = '이동을 검토할 Jira 원본 업무';
  const csv = [
    'Issue id,Issue key,Project key,Summary,Created,Updated,Status,Issue Type',
    `100,${jiraKey},ORIG,${title},2020-01-01T00:00:00Z,2020-01-02T00:00:00Z,Open,Task`,
  ].join('\r\n');
  const query = new URLSearchParams({ filename: `${instanceKey}.csv`, product: 'jira', instanceKey });
  const staged = await call<LegacyPackageSummary>(`/legacy-import/packages?${query}`, 201, 'POST', csv, {
    'Content-Type': 'application/octet-stream',
  });
  const { defaultConfiguration: configuration } = await call<MigrationOptions>(`/migrations/options?packageId=${staged.id}`);
  configuration.projects = configuration.projects.map(project => ({ ...project, key }));
  const preview = await call<MigrationPreview>('/migrations/preview', 201, 'POST', { configuration });
  assert.equal(preview.canApply, true, JSON.stringify(preview.notices));
  const { import: imported } = await call<MigrationApplyResult>(`/migrations/previews/${preview.id}/apply`, 201, 'POST', {
    expectedVersion: preview.version, acknowledgements: preview.requiredAcknowledgements,
  });
  const [projectId] = imported.projectIds;
  const workspace = await call<WorkspaceSnapshot>('/workspace');
  const project = workspace.projects.find(value => value.id === projectId);
  const issue = workspace.issues.find(value => value.projectId === projectId && value.title === title);
  assert.ok(project);
  assert.ok(issue);
  return { project, issue, jiraKey, workspace };
}

test('portable backup keeps moved issue identity, both ledger scopes, permissions, and new GitLab matches by the previous native key', async t => {
  const from = await open(t);
  const to = await open(t);
  const instanceKey = 'move-portability-native-route';
  const { project: source, issue: sourceExample } = await importJiraProject(from, instanceKey, 'MVFROM');
  const sourceShape = { status: sourceExample.status, type: sourceExample.type };
  const jiraRoutes = [{ repositoryId: repository, projectId: source.id, jiraInstanceKey: instanceKey }];
  const target = await from<Project>('/projects', 201, 'POST', { key: 'MVTO', name: '이동 도착' });
  const original = await from<Issue>('/issues', 201, 'POST', { projectId: source.id, title: '포터블 이동 업무', ...sourceShape });
  const other = await from<Issue>('/issues', 201, 'POST', { projectId: target.id, title: '도착 프로젝트의 기존 업무' });
  assert.equal(original.key, 'MVFROM-2');
  assert.equal(other.key, 'MVTO-1');
  await configureGitlab(from, jiraRoutes);
  assert.deepEqual(await mr(from, original.key, 5001), { linked: 1, duplicate: false, ok: true, runs: [] });
  const prior = (await from<WorkspaceSnapshot>('/workspace')).gitlabLinks.find(link => link.issueId === original.id && link.iid === 5001);
  assert.ok(prior);

  const key = async (request: Awaited<ReturnType<typeof open>>, projectId: string) => {
    const created = await request<ApiKeyCreated>('/api-keys', 201, 'POST', { name: `업무 범위 ${projectId}`, access: 'write', projectIds: [projectId] });
    return { Authorization: `Bearer ${created.token}` };
  };
  const sourceKey = await key(from, source.id);
  const destinationKey = await key(from, target.id);
  const path = `/issues/${original.id}`;
  await from(`/v1${path}`, 200, 'GET', undefined, sourceKey);
  await from(`/v1${path}`, 403, 'GET', undefined, destinationKey);
  const input: IssueProjectMoveInput = { expectedVersion: original.version, projectId: target.id, includeConnected: false,
    mappings: [{ issueId: original.id, status: 'review', type: other.type }] };
  await from(`/v1${path}/project-move/preview`, 403, 'POST', input, sourceKey);
  const preview = await from<IssueProjectMovePreview>(`${path}/project-move/preview`, 200, 'POST', input);
  assert.ok(preview.token);
  assert.equal(preview.issues[0].targetKey, 'MVTO-2');
  const result = await from<IssueProjectMoveResult>(`${path}/project-move/apply`, 'ok', 'POST', { ...input, token: preview.token });
  assert.equal(result.duplicate, false);
  assert.equal(result.issues.length, 1);
  const [moved] = result.issues;
  assert.deepEqual({ id: moved.id, projectId: moved.projectId, key: moved.key, status: moved.status, version: moved.version },
    { id: original.id, projectId: target.id, key: 'MVTO-2', status: 'review', version: original.version + 1 });
  assert.deepEqual((await from<WorkspaceSnapshot>('/workspace')).issueMoveOrigins, { [moved.id]: [source.id] });
  await from(`/v1${path}`, 403, 'GET', undefined, sourceKey);
  assert.deepEqual(await from<Issue>(`/v1${path}`, 200, 'GET', undefined, destinationKey), moved);

  const backup = await from<WorkspaceSnapshot & { schemaVersion: number; reportingLedger: { events: IssueReportEvent[] } }>('/export');
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.equal(backup.issueMoveOrigins, undefined);
  const movedOut = backup.reportingLedger.events.findIndex(event => event.issueId === original.id && event.kind === 'moved_out');
  assert.ok(movedOut >= 0);
  const [out, into] = backup.reportingLedger.events.slice(movedOut, movedOut + 2);
  assert.equal(out.projectId, source.id);
  assert.equal(out.before?.key, original.key);
  assert.equal(out.before.statusId, original.status);
  assert.equal(out.after, null);
  assert.equal(into.kind, 'moved_in');
  assert.equal(into.projectId, target.id);
  assert.equal(into.issueId, out.issueId);
  assert.equal(into.before, null);
  assert.equal(into.after?.key, moved.key);
  assert.equal(into.after.statusId, moved.status);
  assert.equal(into.occurredAt, out.occurredAt);

  await to('/import', 400, 'POST', { data: { ...backup, schemaVersion: 82 } });
  await to('/import', 200, 'POST', { data: backup });
  const restored = await to<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(restored.issues.find(issue => issue.id === original.id), moved);
  assert.deepEqual(restored.issueMoveOrigins, { [moved.id]: [source.id] });
  assert.deepEqual(restored.gitlabLinks.find(link => link.id === prior.id), prior);
  await configureGitlab(to, jiraRoutes);
  const nextSource = await to<Issue>('/issues', 201, 'POST', { projectId: source.id, title: '복원 뒤 출발 프로젝트 새 업무', ...sourceShape });
  const nextDestination = await to<Issue>('/issues', 201, 'POST', { projectId: target.id, title: '복원 뒤 도착 프로젝트 새 업무' });
  assert.equal(nextSource.key, 'MVFROM-3');
  assert.equal(nextDestination.key, 'MVTO-3');
  const merged = await mr(to, original.key, 5001, {
    action: 'merge', state: 'merged', title: '업무 키가 없는 병합 MR', source_branch: 'feature/renamed',
  });
  assert.equal(merged.linked, 1);
  assert.equal((await to<WorkspaceSnapshot>('/workspace')).gitlabLinks.find(link => link.id === prior.id)?.state, 'merged');
  const newlyLinked = await mr(to, original.key, 5002);
  assert.equal(newlyLinked.linked, 1);
  assert.equal(newlyLinked.duplicate, false);
  const links = (await to<WorkspaceSnapshot>('/workspace')).gitlabLinks.filter(link => link.iid === 5002);
  assert.equal(links.length, 1);
  assert.equal(links[0].issueId, moved.id);
  assert.equal(links[0].originalJiraKey, undefined);
  assert.equal((await mr(to, moved.key, 5004)).linked, 0);
});

test('Jira origin and its routed GitLab links remain intact when a project move is blocked', async t => {
  const call = await open(t);
  const instanceKey = 'move-portability-jira';
  const { project: { id: projectId }, issue, jiraKey, workspace } = await importJiraProject(call, instanceKey, 'IMVJIRA');
  const target = workspace.projects.find(project => project.id !== projectId)!;
  const history = async () => call<{ sourceRecords: SourceRecordArchive[] }>('/export');
  const origin = (await history()).sourceRecords.find(record => record.targetId === issue.id && record.record.kind === 'issue');
  assert.ok(origin);
  assert.equal(origin.record.metadata.key, jiraKey);
  assert.equal(origin.targetProjectId, projectId);

  const jiraRoutes = [{ repositoryId: repository, projectId, jiraInstanceKey: instanceKey }];
  await configureGitlab(call, jiraRoutes);
  assert.equal((await mr(call, jiraKey, 5003)).linked, 1);
  const link = (await call<WorkspaceSnapshot>('/workspace')).gitlabLinks.find(value => value.iid === 5003);
  assert.ok(link);
  assert.equal(link.issueId, issue.id);
  assert.equal(link.originalJiraKey, jiraKey);

  const route = `/issues/${issue.id}/project-move`;
  const input: IssueProjectMoveInput = { expectedVersion: issue.version, projectId: target.id, includeConnected: false, mappings: [] };
  const blocked = await call<IssueProjectMovePreview>(`${route}/preview`, 200, 'POST', input);
  assert.equal(blocked.token, null);
  assert.ok(blocked.blockers.some(value => value.code === 'jira_origin' && value.issueId === issue.id));
  await call(`${route}/apply`, 409, 'POST', { ...input, token: 'a'.repeat(64) });
  const latest = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(latest.issues.find(value => value.id === issue.id), issue);
  assert.deepEqual(latest.gitlabLinks.find(value => value.id === link.id), link);
  assert.deepEqual((await history()).sourceRecords.find(record => record.id === origin.id), origin);
  assert.deepEqual((await call<GitlabSettings>(integration)).jiraRoutes, jiraRoutes);
});
