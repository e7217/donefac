import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { historicalMigrationBackup } from '../fixtures/historical-migration-backup.js';
import { createApp } from '../../server/app.js';
import type { AtlassianLink } from '../../shared/atlassian-links.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type { IssueProjectMoveInput, IssueProjectMovePreview, IssueProjectMoveResult } from '../../shared/issue-project-move.js';
import type {
  ApiKeyCreated, GitlabSettings, Issue, IssueReportEvent, IssueWorklogPage, LegacyPackageSummary, MigrationApplyResult,
  MigrationOptions, MigrationPreview, Project, ProjectIssueSchema, ProjectWorklogReport, ReportingLedgerData, SourceImport, SourceRecordArchive,
  WorklogEntry, WorkspaceSnapshot,
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

async function importJiraProject(call: Awaited<ReturnType<typeof open>>, instanceKey: string, key: string, withWorklogs = false) {
  const jiraKey = 'ORIG-1';
  const title = '이동을 검토할 Jira 원본 업무';
  const author = { accountId: 'original-developer', displayName: 'Jira 작업자' };
  const date = '2020-01-02T00:00:00Z';
  const csv = [
    'Issue id,Issue key,Project key,Summary,Created,Updated,Status,Issue Type',
    `100,${jiraKey},ORIG,${title},2020-01-01T00:00:00Z,2020-01-02T00:00:00Z,Open,Task`,
  ].join('\r\n');
  const rest = JSON.stringify({ startAt: 0, total: 1, issues: [{ id: '100', key: jiraKey, fields: {
    project: { id: '20', key: 'ORIG', name: 'Jira 원본 프로젝트' }, summary: title, reporter: author,
    status: { id: '1', name: 'Open' }, issuetype: { id: '3', name: 'Task' }, created: date, updated: date,
    worklog: { startAt: 0, total: 2, worklogs: [91, 42].map((seconds, index) => ({
      id: String(610 + index), author, timeSpentSeconds: seconds, comment: `이관 작업 시간 ${seconds}초`, started: date, created: date, updated: date,
    })) },
  } }] });
  const query = new URLSearchParams({ filename: `${instanceKey}.${withWorklogs ? 'json' : 'csv'}`, product: 'jira', instanceKey });
  const staged = await call<LegacyPackageSummary>(`/legacy-import/packages?${query}`, 201, 'POST', withWorklogs ? rest : csv, {
    'Content-Type': 'application/octet-stream',
  });
  const { defaultConfiguration: configuration, identities } = await call<MigrationOptions>(`/migrations/options?packageId=${staged.id}`);
  configuration.projects = configuration.projects.map(project => ({ ...project, key }));
  if (withWorklogs) {
    const identity = identities.find(value => value.sourceValue === author.accountId);
    assert.ok(identity);
    configuration.users[identity.id] = 'user-seo';
    configuration.sourceBaseUrls = { [staged.id]: 'https://jira.example.test/legacy' };
  }
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
  return { project, issue, jiraKey, imported };
}

test('portable backup keeps moved issue identity, both ledger scopes, permissions, and GitLab matches by the previous and current keys', async t => {
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
  assert.equal((await mr(to, moved.key, 5004, { title: '이동 후 새 브랜치의 MR' })).linked, 1);
  assert.equal((await mr(to, other.key, 5005)).linked, 0);
  const links = (await to<WorkspaceSnapshot>('/workspace')).gitlabLinks
    .filter(link => [5002, 5004, 5005].includes(link.iid)).sort((left, right) => left.iid - right.iid);
  assert.deepEqual(links.map(link => [link.iid, link.issueId, link.originalJiraKey]),
    [[5002, moved.id, undefined], [5004, moved.id, undefined]]);
});

test('a moved Jira ticket keeps immutable origins, routed GitLab links and second-level worklogs through native backup', async t => {
  const call = await open(t);
  const restore = await open(t);
  const instanceKey = 'move-portability-jira';
  const { project: { id: projectId }, issue, jiraKey, imported } = await importJiraProject(call, instanceKey, 'IMVJIRA', true);
  const target = await call<Project>('/projects', 201, 'POST', { key: 'MOVED', name: '이관 업무의 도착 프로젝트' });
  type Backup = WorkspaceSnapshot & { schemaVersion: number; reportingLedger: ReportingLedgerData; sourceRecords: SourceRecordArchive[];
    sourceImports: SourceImport[]; worklogs: (WorklogEntry & { deletedAt: string | null; createHash: string })[] };
  const archive = () => call<Backup>('/export');
  const worklogPath = `/issues/${issue.id}/worklogs`;
  const report = (id: string) => `/projects/${id}/worklog-report?startDate=2020-01-02&endDate=2020-01-02`;
  const sourceLinks = `/atlassian-links?targetType=issue&targetId=${issue.id}`;
  const logs = await call<IssueWorklogPage>(worklogPath);
  const live = logs.entries.find(entry => entry.durationSeconds === 91), deleted = logs.entries.find(entry => entry.durationSeconds === 42);
  assert.ok(live && deleted && live.sourceRecordId && deleted.sourceRecordId);
  await call(`${worklogPath}/${deleted.id}`, 200, 'DELETE', { expectedVersion: deleted.version }, { 'X-Actor-Id': 'user-seo' });
  const before = await archive();
  const origin = before.sourceRecords.find(record => record.targetId === issue.id && record.record.kind === 'issue');
  assert.ok(origin);
  assert.equal(origin.record.metadata.key, jiraKey);
  assert.equal(origin.targetProjectId, projectId);
  assert.equal(before.sourceRecords.find(record => record.id === live.sourceRecordId)?.targetProjectId, projectId);
  const originLinks = await call<AtlassianLink[]>(sourceLinks);
  assert.equal(originLinks[0].url, `https://jira.example.test/legacy/browse/${jiraKey}`);

  const jiraRoutes = [{ repositoryId: repository, projectId, jiraInstanceKey: instanceKey }];
  await configureGitlab(call, jiraRoutes);
  assert.equal((await mr(call, jiraKey, 5003)).linked, 1);
  const link = (await call<WorkspaceSnapshot>('/workspace')).gitlabLinks.find(value => value.iid === 5003);
  assert.ok(link);
  assert.equal(link.issueId, issue.id);
  assert.equal(link.originalJiraKey, jiraKey);

  const route = `/issues/${issue.id}/project-move`;
  const targetSchema = await call<ProjectIssueSchema>(`/projects/${target.id}/issue-schema`);
  const input: IssueProjectMoveInput = { expectedVersion: issue.version, projectId: target.id, includeConnected: false,
    mappings: [{ issueId: issue.id, status: 'review', type: targetSchema.issueTypes.find(value => !value.archived)!.id }] };
  const preview = await call<IssueProjectMovePreview>(`${route}/preview`, 200, 'POST', input);
  assert.ok(preview.token, JSON.stringify(preview.blockers));
  assert.ok(preview.warnings.some(value => value.code === 'jira_origin_preserved' && value.issueId === issue.id));
  assert.ok(preview.warnings.some(value => value.code === 'worklogs_transferred' && value.issueId === issue.id));
  const { issues: [moved] } = await call<IssueProjectMoveResult>(`${route}/apply`, 200, 'POST', { ...input, token: preview.token });
  const latest = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(latest.issues.find(value => value.id === issue.id), moved);
  assert.deepEqual(latest.gitlabLinks.find(value => value.id === link.id), link);
  assert.deepEqual(await call(sourceLinks), originLinks);
  assert.deepEqual((await call<GitlabSettings>(integration)).jiraRoutes, jiraRoutes);
  assert.equal((await mr(call, jiraKey, 5033)).linked, 1);
  assert.equal((await mr(call, moved.key, 5035, { title: '이관 업무의 새 브랜치', source_branch: `feature/${moved.key.toLowerCase()}` })).linked, 1);
  assert.equal((await call<ProjectWorklogReport>(report(projectId))).minutes, 0);
  const movedReport = await call<ProjectWorklogReport>(report(target.id));
  assert.equal(movedReport.minutes, 91 / 60);
  assert.equal(movedReport.byIssue[0].key, moved.key);
  const currentWorklog = { ...live, projectId: target.id, issueKey: moved.key, issueTitle: moved.title };
  assert.deepEqual(await call(worklogPath), { entries: [currentWorklog], totalMinutes: 91 / 60, totalEntries: 1 });

  const backup = await archive();
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.deepEqual(backup.sourceRecords, before.sourceRecords);
  assert.deepEqual(backup.sourceImports.find(receipt => receipt.id === imported.id), imported);
  assert.deepEqual(backup.worklogs, before.worklogs.map(entry => entry.issueId === issue.id
    ? { ...entry, projectId: target.id, issueKey: moved.key, issueTitle: moved.title } : entry));
  await restore('/import', 400, 'POST', { data: historicalMigrationBackup(backup, 108) });
  await restore('/import', 400, 'POST', { data: { ...backup, reportingLedger: { ...backup.reportingLedger, events: [] } } });
  await restore('/import', 200, 'POST', { data: backup });
  assert.deepEqual(await restore(worklogPath), { entries: [currentWorklog], totalMinutes: 91 / 60, totalEntries: 1 });
  assert.deepEqual(await restore(report(target.id)), movedReport);
  assert.deepEqual(await restore(sourceLinks), originLinks);
  await configureGitlab(restore, jiraRoutes);
  assert.equal((await mr(restore, jiraKey, 5034)).linked, 1);
  assert.equal((await mr(restore, moved.key, 5036, { title: '복원 뒤 새 브랜치의 MR' })).linked, 1);
  const links = (await restore<WorkspaceSnapshot>('/workspace')).gitlabLinks
    .filter(value => [5033, 5034, 5035, 5036].includes(value.iid)).sort((left, right) => left.iid - right.iid);
  assert.deepEqual(links.map(value => [value.iid, value.issueId, value.originalJiraKey]), [
    [5033, issue.id, jiraKey], [5034, issue.id, jiraKey], [5035, issue.id, undefined], [5036, issue.id, undefined],
  ]);
});

test('a moved current key does not disambiguate a different Jira issue in the routed repository', async t => {
  const call = await open(t);
  const instanceKey = 'move-portability-key-collision';
  const { project: source, issue: imported, jiraKey } = await importJiraProject(call, instanceKey, 'KEYFROM');
  const target = await call<Project>('/projects', 201, 'POST', { key: 'ORIG', name: '이관 키와 충돌하는 도착 프로젝트' });
  const native = await call<Issue>('/issues', 201, 'POST', {
    projectId: source.id, status: imported.status, type: imported.type, title: '이동할 Teamspace 업무',
  });
  const targetSchema = await call<ProjectIssueSchema>(`/projects/${target.id}/issue-schema`);
  const path = `/issues/${native.id}/project-move`;
  const input: IssueProjectMoveInput = { expectedVersion: native.version, projectId: target.id, includeConnected: false,
    mappings: [{ issueId: native.id, status: 'review', type: targetSchema.issueTypes.find(value => !value.archived)!.id }] };
  const preview = await call<IssueProjectMovePreview>(`${path}/preview`, 200, 'POST', input);
  assert.ok(preview.token, JSON.stringify(preview.blockers));
  const { issues: [moved] } = await call<IssueProjectMoveResult>(`${path}/apply`, 200, 'POST', { ...input, token: preview.token });
  assert.equal(moved.key, jiraKey);

  await configureGitlab(call, [{ repositoryId: repository, projectId: source.id, jiraInstanceKey: instanceKey }]);
  assert.equal((await mr(call, moved.key, 5037)).linked, 0);
  assert.equal((await mr(call, native.key, 5038)).linked, 1);
  assert.equal((await mr(call, imported.key, 5039)).linked, 1);
  const links = (await call<WorkspaceSnapshot>('/workspace')).gitlabLinks.sort((left, right) => left.iid - right.iid);
  assert.deepEqual(links.map(link => [link.iid, link.issueId, link.originalJiraKey]),
    [[5038, moved.id, undefined], [5039, imported.id, undefined]]);
});
