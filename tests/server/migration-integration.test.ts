import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import fileSystem from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { zip } from '../fixtures/legacy-export-zip.mjs';
import type { AtlassianLink, AtlassianLinkTarget } from '../../shared/atlassian-links.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type { ApiKeyCreated, Attachment, AttachmentHead, AttachmentVersion, AutomationRule, AutomationRun, Comment, DocPage, GitlabSettings, GitlabSyncPreview, GitlabSyncResult, LegacyPackageSummary, MigrationApplyResult, MigrationConfiguration, MigrationOptions, MigrationPreview, ProjectWorkflow, RichContent, SourceImport, SourceImportIntegrityPackage, SourceReconciliationAudit, SourceReconciliationFileCheck, SourceReconciliationPage, SourceRecordArchive, SourceRecordPage, WebhookEndpointCreated, WorkspaceSnapshot } from '../../shared/types.js';
import { createApp } from '../../server/app.js';
import { AttachmentAppend, type AppendedFile } from '../../server/attachment-append.js';
import { hash } from '../../server/attachments.js';

async function fixture(atlassianEnv?: NodeJS.ProcessEnv) {
  const dir = mkdtempSync(join(tmpdir(), 'teamspace-migration-integration-')), service = createApp({ dataDir: dir, outboundWorker: false, atlassianEnv }), server = service.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}/api`, db = new DatabaseSync(join(dir, 'teamspace.sqlite')); db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
  async function call<T = unknown>(path: string, method = 'GET', body?: unknown, actor = 'user-seo') { const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actor }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json() as T }; }
  async function upload(bytes: Buffer, filename: string, product = 'auto') { const params = new URLSearchParams({ filename, product, instanceKey: `synthetic-${randomUUID()}` }); const response = await fetch(`${base}/legacy-import/packages?${params}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': 'user-seo' }, body: new Uint8Array(bytes) }); const data = await response.json() as LegacyPackageSummary; assert.equal(response.status, 201, JSON.stringify(data)); return data; }
  async function configuration(packages: LegacyPackageSummary | LegacyPackageSummary[], key = `MIG${randomUUID().replaceAll('-', '').slice(0, 7).toUpperCase()}`) {
    const params = new URLSearchParams((Array.isArray(packages) ? packages : [packages]).map(pkg => ['packageId', pkg.id]));
    const result = await call<MigrationOptions>(`/migrations/options?${params}`); assert.equal(result.status, 200);
    const config = result.data.defaultConfiguration; config.projects = config.projects.map(value => ({ ...value, key, name: 'Synthetic unified migration' })); config.datePolicy = 'import-time'; for (const identity of result.data.identities) config.users[identity.id] = 'user-jun'; return config;
  }
  async function preview(configuration: MigrationConfiguration) { const result = await call<MigrationPreview>('/migrations/preview', 'POST', { configuration }); assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data; }
  async function apply(plan: MigrationPreview, extra: Record<string, unknown> = {}, actor = 'user-seo') { return call<MigrationApplyResult>(`/migrations/previews/${plan.id}/apply`, 'POST', { expectedVersion: plan.version, acknowledgements: plan.requiredAcknowledgements, ...extra }, actor); }
  return { dir, base, db, call, upload, configuration, preview, apply, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); service.close(); db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const csv = Buffer.from('Issue id,Issue key,Project key,Summary,Description,Reporter,Created,Updated,Status,Issue Type,Comment\r\n100,OLD-1,OLD,Synthetic imported issue one,"h2. 원본 설명",original.author,2020-01-01T00:00:00Z,2020-01-02T00:00:00Z,Open,Task,"2020-01-03T00:00:00Z;original.author;보존한 댓글"\r\n200,OTHER-1,OTHER,Synthetic imported issue two,두번째 설명,original.author,2020-01-01T00:00:00Z,2020-01-02T00:00:00Z,Open,Task,\r\n');

function jiraGitlabCsv(rows: Array<[sourceId: string, originalKey: string, title: string, status: string]>): Buffer {
  const header = 'Issue id,Issue key,Project key,Summary,Created,Updated,Status,Issue Type';
  const lines = rows.map(([id, key, title, status]) => `${id},${key},${key.split('-')[0]},${title},2020-01-01T00:00:00Z,2020-01-02T00:00:00Z,${status},Task`);
  return Buffer.from([header, ...lines].join('\r\n'));
}

type MigrationFixture = Awaited<ReturnType<typeof fixture>>;
const gitlabPath = '/integrations/gitlab';
const historicAt = '2020-01-02T00:00:00.000Z';
const syntheticSecret = 'migration-gitlab-synthetic-secret';
const historicalBranch = 'feature/repository-history';
const historicalHash = 'a'.repeat(40);

async function importJiraForGitlab(f: MigrationFixture, projectKey: string, rows: Parameters<typeof jiraGitlabCsv>[0]) {
  const original = await f.upload(jiraGitlabCsv(rows), `${projectKey}-history.csv`, 'jira');
  const preview = await f.preview(await f.configuration(original, projectKey));
  assert.equal(preview.canApply, true, JSON.stringify(preview.notices));
  const response = await f.apply(preview);
  assert.equal(response.status, 201, JSON.stringify(response.data));
  const [projectId] = response.data.import.projectIds;
  assert.ok(projectId);
  const current = await f.call<WorkspaceSnapshot>('/workspace');
  const issues = current.data.issues.filter(issue => issue.projectId === projectId).sort((left, right) => left.key.localeCompare(right.key));
  assert.equal(issues.length, rows.length);
  return { projectId, jiraInstanceKey: original.source.instanceKey, issues };
}

async function localGitlab(t: TestContext, respond: (path: string, base: string) => unknown) {
  let base = '';
  const reads: { path: string; method: string | undefined }[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', base).pathname;
    reads.push({ path, method: request.method });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(respond(path, base)));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/forge`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return { base, reads };
}

function gitlabMr(base: string, projectId: number, iid: number, title: string, branch = historicalBranch, sha = historicalHash, date = historicAt) {
  return { id: iid, iid, title, state: 'merged', source_branch: branch, last_commit: { id: sha }, updated_at: date, web_url: `${base}/team/repo-${projectId}/-/merge_requests/${iid}` };
}

async function gitlabHook(f: MigrationFixture, body: unknown, secret = syntheticSecret, id = randomUUID()) {
  const result = await fetch(`${f.base}${gitlabPath}/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Gitlab-Token': secret, 'webhook-id': id }, body: JSON.stringify(body),
  });
  return { status: result.status, data: await result.json() as { linked: number; duplicate: boolean; runs: AutomationRun[] } };
}

async function enableMigrationGitlabRule(f: MigrationFixture, projectId: string, repositoryId: number, from: string, to: string) {
  const reply = await f.call<AutomationRule>('/automation-rules', 'POST', {
    projectId, name: `저장소 ${repositoryId} 병합 후 완료`, trigger: 'merge_request.merged', enabled: true,
    gitlabProjectIds: [repositoryId], branchPattern: 'feature/*', issueTypes: [], fromStatuses: [from], toStatusId: to,
    actorId: 'user-seo', priority: 100,
  });
  assert.equal(reply.status, 201, JSON.stringify(reply.data));
  return reply.data;
}

test('explicit repository routes match imported Jira keys only for their selected source and preserve GitLab live event policy', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const baseline = await f.call<WorkspaceSnapshot & { schemaVersion: number }>('/export');
  assert.equal(baseline.status, 200);
  const originA = await importJiraForGitlab(f, 'MOVA', [
    ['RAWALI-9', 'OLD-1', '첫 번째 원본의 티켓', 'Open'], ['200', 'ALPHA-8', '첫 번째 원본의 완료 상태', 'Closed'],
  ]);
  const originB = await importJiraForGitlab(f, 'MOVB', [
    ['100', 'OLD-1', '두 번째 원본의 티켓', 'Open'], ['200', 'BETA-9', '다른 인스턴스에만 있는 티켓', 'Closed'],
  ]);
  const [targetA] = originA.issues;
  const [targetB] = originB.issues;
  assert.notEqual(targetA.key, 'OLD-1');
  assert.notEqual(targetB.key, 'OLD-1');
  assert.notEqual(originA.jiraInstanceKey, originB.jiraInstanceKey);
  const destinations = [originA, originB].map(({ projectId, jiraInstanceKey }) => ({ projectId, jiraInstanceKey }));
  const available = await f.call<typeof destinations>(`${gitlabPath}/jira-sources`);
  assert.equal(available.status, 200, JSON.stringify(available.data));
  assert.deepEqual(new Set(available.data.map(value => JSON.stringify([value.projectId, value.jiraInstanceKey]))),
    new Set(destinations.map(value => JSON.stringify([value.projectId, value.jiraInstanceKey]))));

  const namedBranch = 'feature/OLD-1-history';
  const commitHash = 'c'.repeat(40);
  let restBranchHash = historicalHash;
  const upstream = await localGitlab(t, (path, base) => {
    const [, repo, endpoint] = /^\/forge\/api\/v4\/projects\/(42|43)(?:\/(.*))?$/.exec(path) ?? [];
    const repoId = Number(repo);
    if (!endpoint) return { id: repoId, path_with_namespace: `team/repo-${repo}`, web_url: `${base}/team/repo-${repo}` };
    if (endpoint === 'merge_requests') return [
      gitlabMr(base, repoId, 101, 'OLD-1 원래 키로 연 MR'),
      ...(repoId === 42 ? [
        gitlabMr(base, repoId, 102, `OLD-1 ${targetA.key} 같은 티켓을 두 번 언급`, 'feature/dual-reference', 'd'.repeat(40)),
        gitlabMr(base, repoId, 103, 'NEO-1 범위 밖 현재 키', 'feature/outside', 'e'.repeat(40)),
        gitlabMr(base, repoId, 104, 'BETA-9 다른 원본 키', 'feature/other-origin', 'f'.repeat(40)),
        gitlabMr(base, repoId, 105, 'RAWALI-9 원본 키가 아닌 원본 객체 ID', 'feature/raw-id', 'b'.repeat(40)),
      ] : [gitlabMr(base, repoId, 201, 'NEO-1 매핑 없는 저장소의 현재 키', 'feature/current-ticket', 'd'.repeat(40))]),
    ];
    if (endpoint === 'pipelines') return [
      { id: 301, ref: historicalBranch, sha: historicalHash, status: 'success', updated_at: historicAt, web_url: `${base}/team/repo-${repo}/-/pipelines/301` },
      { id: 302, ref: historicalBranch, sha: '5'.repeat(40), status: 'success', updated_at: historicAt, web_url: `${base}/team/repo-${repo}/-/pipelines/302` },
    ];
    if (endpoint === 'repository/branches') return [{ name: namedBranch, commit: { id: restBranchHash } }];
    if (endpoint === 'repository/commits') return [{ id: commitHash, title: '이전 커밋', message: 'OLD-1 원본 Jira 참조', committed_date: historicAt }];
    return [];
  });

  const empty = await f.call<GitlabSettings>(gitlabPath);
  const config = await f.call<GitlabSettings>(gitlabPath, 'PATCH', {
    expectedVersion: empty.data.version, baseUrl: upstream.base, projectIds: [42, 43], webhookSecret: syntheticSecret,
  });
  assert.equal(config.status, 200, JSON.stringify(config.data));
  const selected = [{ repositoryId: 42, ...destinations[0] }];
  const wrongOrigin = [{ repositoryId: 42, projectId: originA.projectId, jiraInstanceKey: originB.jiraInstanceKey }];
  const denied = await f.call(gitlabPath, 'PATCH', { expectedVersion: config.data.version, jiraRoutes: wrongOrigin });
  assert.equal(denied.status, 400, JSON.stringify(denied.data));
  const unauthorized = await f.call(gitlabPath, 'PATCH', { expectedVersion: config.data.version, jiraRoutes: [{ ...selected[0], repositoryId: 99 }] });
  assert.equal(unauthorized.status, 400, JSON.stringify(unauthorized.data));
  assert.deepEqual((await f.call<GitlabSettings>(gitlabPath)).data, config.data);

  const before = (await f.call<WorkspaceSnapshot>('/workspace')).data;
  const previewRequest = { expectedVersion: config.data.version, includeHistory: true };
  const unmapped = await f.call<GitlabSyncPreview>(`${gitlabPath}/sync-preview`, 'POST', previewRequest);
  assert.equal(unmapped.status, 200, JSON.stringify(unmapped.data));
  assert.ok(!unmapped.data.candidates.some(item => item.kind === 'merge_request' && item.objectId === '101'));
  const preview = await f.call<GitlabSyncPreview>(`${gitlabPath}/sync-preview`, 'POST', { ...previewRequest, jiraRoutes: selected });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  const candidates = preview.data.candidates;
  const mapped = candidates.filter(candidate => candidate.projectId === 42);
  assert.equal(mapped.length, 5);
  assert.ok(mapped.every(candidate => candidate.issueId === targetA.id && candidate.issueKey === targetA.key && candidate.action === 'create'));
  assert.deepEqual(mapped.map(({ kind }) => kind).sort(), ['branch', 'commit', 'merge_request', 'merge_request', 'pipeline']);
  assert.deepEqual(mapped.filter(item => item.kind === 'merge_request').map(item => item.objectId).sort(), ['101', '102']);
  assert.equal(mapped.find(item => item.kind === 'merge_request' && item.objectId === '101')?.originalJiraKey, 'OLD-1');
  assert.equal(mapped.find(item => item.kind === 'pipeline')?.objectId, '301');
  assert.equal(mapped.find(item => item.kind === 'pipeline')?.originalJiraKey, 'OLD-1');
  assert.deepEqual(candidates.filter(candidate => candidate.projectId === 43).map(item => [item.kind, item.issueKey]), [['merge_request', 'NEO-1']]);
  assert.deepEqual((await f.call<GitlabSettings>(gitlabPath)).data, config.data);
  assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).data, before);

  const saved = await f.call<GitlabSettings>(gitlabPath, 'PATCH', { expectedVersion: config.data.version, jiraRoutes: selected });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.deepEqual(saved.data.jiraRoutes, selected);
  const workflow = (await f.call<ProjectWorkflow>(`/projects/${originA.projectId}/workflow`)).data;
  const completed = workflow.statuses.find(status => status.category === 'done');
  assert.ok(completed);
  const aliasAutomation = await enableMigrationGitlabRule(f, originA.projectId, 42, targetA.status, completed.id);
  const unrelated = await enableMigrationGitlabRule(f, 'project-neo', 43, 'in_progress', 'done');

  const sync = await f.call<GitlabSyncResult>(`${gitlabPath}/sync`, 'POST', { includeHistory: true });
  assert.equal(sync.status, 200, JSON.stringify(sync.data));
  assert.equal(sync.data.linked, candidates.length);
  const afterSync = (await f.call<WorkspaceSnapshot>('/workspace')).data;
  assert.deepEqual(afterSync.issues, before.issues);
  assert.deepEqual((await f.call<AutomationRun[]>('/automation-runs')).data, []);
  assert.equal(afterSync.gitlabLinks.filter(link => link.projectId === 42 && link.issueId === targetA.id).length, 5);
  assert.ok(afterSync.gitlabLinks.filter(link => ['branch', 'commit', 'pipeline'].includes(link.kind)).every(link =>
    link.projectId === 42 && link.issueId === targetA.id && link.originalJiraKey === 'OLD-1'));
  assert.ok(upstream.reads.length > 0 && upstream.reads.every(request => request.method === 'GET'));

  function readIssue(id: string) { return f.call<WorkspaceSnapshot>('/workspace').then(snapshot => snapshot.data.issues.find(issue => issue.id === id)); }
  const liveBranch = 'feature/live-event';
  const liveHash = 'b'.repeat(40);
  const fresh = (projectId: number, iid: number) => ({
    object_kind: 'merge_request', project: { id: projectId },
    object_attributes: { ...gitlabMr(upstream.base, projectId, iid, 'OLD-1 인증 웹훅', liveBranch, liveHash, new Date().toISOString()), action: 'merge' },
  });
  assert.equal((await gitlabHook(f, fresh(42, 401), 'incorrect-token')).status, 401);
  assert.equal((await gitlabHook(f, fresh(99, 401))).status, 403);
  const wrongRepo = await gitlabHook(f, fresh(43, 401));
  assert.equal(wrongRepo.status, 200, JSON.stringify(wrongRepo.data));
  assert.equal(wrongRepo.data.linked, 0);
  assert.deepEqual(wrongRepo.data.runs, []);
  assert.deepEqual(await readIssue(targetA.id), targetA);
  const eventId = randomUUID();
  const event = fresh(42, 401);
  const live = await gitlabHook(f, event, syntheticSecret, eventId);
  assert.equal(live.status, 200, JSON.stringify(live.data));
  assert.equal(live.data.linked, 1);
  assert.deepEqual(live.data.runs.map(run => [run.issueId, run.ruleId, run.outcome]), [[targetA.id, aliasAutomation.id, 'changed']]);
  assert.equal((await readIssue(targetA.id))?.status, completed.id);
  assert.equal((await readIssue(targetA.id))?.version, targetA.version + 1);
  assert.deepEqual(await readIssue(targetB.id), targetB);
  assert.equal((await gitlabHook(f, event, syntheticSecret, eventId)).data.duplicate, true);

  const pipeline = (id: number, sha: string) => ({
    object_kind: 'pipeline', project: { id: 42, web_url: `${upstream.base}/team/repo-42` },
    object_attributes: { id, sha, ref: liveBranch, status: 'success', finished_at: new Date().toISOString() },
  });
  assert.equal((await gitlabHook(f, pipeline(501, '8'.repeat(40)))).data.linked, 0);
  assert.equal((await gitlabHook(f, pipeline(502, liveHash))).data.linked, 1);
  const push = (branch: string, before: string, after: string, commits: { id: string; title: string; message: string }[] = []) => gitlabHook(f, {
    object_kind: 'push', project: { id: 42, web_url: `${upstream.base}/team/repo-42`, path_with_namespace: 'team/repo-42' },
    ref: `refs/heads/${branch}`, before, after, commits,
  });
  const pushed = await push('feature/OLD-1-live', '0'.repeat(40), '1'.repeat(40), [
    { id: '1'.repeat(40), title: '일반 커밋', message: '브랜치의 원래 키를 물려받음' },
  ]);
  assert.equal(pushed.status, 200, JSON.stringify(pushed.data));
  assert.equal(pushed.data.linked, 2);
  assert.deepEqual(pushed.data.runs, []);
  const liveLinks = (await f.call<WorkspaceSnapshot>('/workspace')).data.gitlabLinks;
  assert.ok(liveLinks.some(link => link.iid === 502 && link.kind === 'pipeline' && link.issueId === targetA.id && link.originalJiraKey === 'OLD-1'));
  assert.equal(liveLinks.filter(link => link.sourceBranch === 'feature/OLD-1-live' && link.issueId === targetA.id && link.originalJiraKey === 'OLD-1').length, 2);
  const observed = await push(namedBranch, '0'.repeat(40), historicalHash);
  assert.equal(observed.status, 200, JSON.stringify(observed.data));
  assert.equal(observed.data.linked, 1);
  const earlierBranch = (await f.call<WorkspaceSnapshot>('/workspace')).data.gitlabLinks.find(link => link.kind === 'branch' && link.sourceBranch === namedBranch && link.issueId === targetA.id);
  assert.ok(earlierBranch?.sourceSha === historicalHash && earlierBranch.branchObservationSource === undefined);

  const otherRoute = [{ repositoryId: 42, ...destinations[1] }];
  const remapped = await f.call<GitlabSettings>(gitlabPath, 'PATCH', { expectedVersion: saved.data.version, jiraRoutes: otherRoute });
  assert.equal(remapped.status, 200, JSON.stringify(remapped.data));
  const rules = (await f.call<AutomationRule[]>('/automation-rules')).data;
  assert.equal(rules.find(rule => rule.id === aliasAutomation.id)?.enabled, false);
  assert.equal(rules.find(rule => rule.id === unrelated.id)?.enabled, true);
  const inheritedBeforeRemap = await gitlabHook(f, pipeline(503, liveHash));
  assert.equal(inheritedBeforeRemap.status, 200, JSON.stringify(inheritedBeforeRemap.data));
  assert.equal(inheritedBeforeRemap.data.linked, 0, 'A stored MR from the previous route cannot choose a target after remapping.');

  async function branchCandidates() {
    const reply = await f.call<GitlabSyncPreview>(`${gitlabPath}/sync-preview`, 'POST', { expectedVersion: remapped.data.version, includeHistory: true });
    assert.equal(reply.status, 200, JSON.stringify(reply.data));
    return reply.data.candidates.filter(link => link.kind === 'branch');
  }
  restBranchHash = '9'.repeat(40);
  assert.deepEqual(await branchCandidates(), [], 'A disconnected snapshot cannot override an authenticated branch observation.');
  restBranchHash = historicalHash;
  assert.deepEqual((await branchCandidates()).map(candidate => [candidate.issueId, candidate.originalJiraKey, candidate.action]), [[targetB.id, 'OLD-1', 'create']]);
  const reassociate = await f.call<GitlabSyncResult>(`${gitlabPath}/sync`, 'POST', { includeHistory: true });
  assert.equal(reassociate.status, 200, JSON.stringify(reassociate.data));
  const laterBranch = (await f.call<WorkspaceSnapshot>('/workspace')).data.gitlabLinks.find(link => link.kind === 'branch' && link.sourceBranch === namedBranch && link.issueId === targetB.id);
  assert.ok(laterBranch);
  assert.equal(laterBranch.sourceSha, earlierBranch.sourceSha);
  assert.equal(laterBranch.updatedAt, earlierBranch.updatedAt);
  assert.equal(laterBranch.webUrl, earlierBranch.webUrl);
  assert.equal(laterBranch.state, 'active');
  assert.equal(laterBranch.branchObservationSource, undefined);
  assert.equal(laterBranch.originalJiraKey, 'OLD-1');
  const deleted = await push(namedBranch, historicalHash, '0'.repeat(40));
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  assert.deepEqual(await branchCandidates(), [], 'A deleted authenticated branch cannot be re-created from the old snapshot.');

  const newest = await gitlabHook(f, fresh(42, 601));
  assert.equal(newest.status, 200, JSON.stringify(newest.data));
  assert.equal(newest.data.linked, 1);
  assert.deepEqual(newest.data.runs, []);
  assert.deepEqual(await readIssue(targetB.id), targetB);

  const backup = await f.call<WorkspaceSnapshot & { schemaVersion: number }>('/export');
  assert.equal(backup.status, 200);
  assert.equal(backup.data.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.ok(backup.data.gitlabLinks.some(link => link.iid === 601 && link.issueId === targetB.id && link.originalJiraKey === 'OLD-1'));
  assert.equal(Object.hasOwn(backup.data, 'jiraRoutes'), false, 'The mapping is local GitLab connection configuration.');
  assert.equal((await f.call('/import', 'POST', { data: { ...backup.data, schemaVersion: 34 } })).status, 400);
  assert.equal((await f.call('/import', 'POST', { data: backup.data })).status, 200);
  assert.deepEqual((await f.call<GitlabSettings>(gitlabPath)).data.jiraRoutes, otherRoute);
  const restored = (await f.call<WorkspaceSnapshot>('/workspace')).data.gitlabLinks;
  assert.deepEqual(restored, backup.data.gitlabLinks);
  const legacy = structuredClone(backup.data);
  legacy.schemaVersion = 34;
  for (const link of legacy.gitlabLinks) delete link.originalJiraKey;
  assert.equal((await f.call('/import', 'POST', { data: legacy })).status, 200);
  assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).data.gitlabLinks, legacy.gitlabLinks);

  assert.equal((await f.call('/import', 'POST', { data: baseline.data })).status, 200);
  const reset = (await f.call<GitlabSettings>(gitlabPath)).data;
  assert.deepEqual(reset.jiraRoutes ?? [], []);
  assert.deepEqual(reset.projectIds, [42, 43]);
  assert.equal(reset.webhookSecretConfigured, true);
});

test('repositories skip colliding Jira and current keys for distinct tickets while matching other unambiguous tokens', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const origin = await importJiraForGitlab(f, 'OLD', [
    ['200', 'OTHER-1', '현재 키가 충돌하는 티켓', 'Open'], ['100', 'OLD-1', '이전 키가 충돌하는 티켓', 'Open'],
  ]);
  const [current, renamed] = origin.issues;
  assert.equal(current.key, 'OLD-1');
  assert.equal(renamed.key, 'OLD-2');
  const upstream = await localGitlab(t, (path, base) => path.endsWith('/merge_requests') ? [
    gitlabMr(base, 42, 901, 'OLD-1 키 충돌'), gitlabMr(base, 42, 902, 'OLD-1 OLD-2 다른 키는 연결', 'feature/another-token', 'b'.repeat(40)),
  ] : []);
  const base = (await f.call<GitlabSettings>(gitlabPath)).data;
  const config = await f.call<GitlabSettings>(gitlabPath, 'PATCH', {
    expectedVersion: base.version, baseUrl: upstream.base, projectIds: [42], webhookSecret: syntheticSecret,
    jiraRoutes: [{ repositoryId: 42, projectId: origin.projectId, jiraInstanceKey: origin.jiraInstanceKey }],
  });
  assert.equal(config.status, 200, JSON.stringify(config.data));
  const preview = await f.call<GitlabSyncPreview>(`${gitlabPath}/sync-preview`, 'POST', { expectedVersion: config.data.version });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.deepEqual(preview.data.repositories[0].ambiguousKeys, ['OLD-1']);
  assert.deepEqual(preview.data.candidates.map(candidate => [candidate.objectId, candidate.issueId, candidate.originalJiraKey]), [['902', renamed.id, undefined]]);
  const sync = await f.call<GitlabSyncResult>(`${gitlabPath}/sync`, 'POST', {});
  assert.equal(sync.status, 200, JSON.stringify(sync.data));
  assert.equal(sync.data.linked, 1);
  const live = await gitlabHook(f, { object_kind: 'merge_request', project: { id: 42 }, object_attributes: {
    ...gitlabMr(upstream.base, 42, 903, 'OLD-1 인증된 충돌', 'feature/collision', historicalHash, new Date().toISOString()), action: 'merge',
  } });
  assert.equal(live.status, 200, JSON.stringify(live.data));
  assert.equal(live.data.linked, 0);
  assert.deepEqual(live.data.runs, []);
  const links = (await f.call<WorkspaceSnapshot>('/workspace')).data.gitlabLinks;
  assert.deepEqual(links.map(link => [link.iid, link.issueId]), [[902, renamed.id]]);
});

function confluence(withAuditFixtures = false) {
  const first = Buffer.from('첫 버전\r\n\x00바이너리'), latest = Buffer.from('두 번째 버전😀\r\n원본');
  const prop = (name: string, text: string) => `<property name="${name}">${text}</property>`, ref = (name: string, type: string, id: string) => `<property name="${name}" class="${type}"><id name="id">${id}</id></property>`, object = (type: string, id: string, text: string) => `<object class="${type}"><id name="id">${id}</id>${text}</object>`;
  const historical = withAuditFixtures ? '<collection name="historicalVersions"><element class="Page"><id name="id">101</id></element></collection>' : '';
  const extra = withAuditFixtures ? [
    object('Page', '101', prop('title', 'Synthetic historical page') + prop('version', '1') + prop('contentStatus', 'historical') + ref('originalVersion', 'Page', '100') + ref('space', 'Space', '42')),
    object('BodyContent', '301', '<property name="body"><![CDATA[<p>보존한 이전 본문</p>]]></property>' + ref('content', 'Page', '101')),
    object('Comment', '400', ref('containerContent', 'Page', '100') + prop('creationDate', '2020-01-03T00:00:00Z')),
    object('BodyContent', '401', '<property name="body"><![CDATA[<p>보존한 원본 댓글</p>]]></property>' + ref('content', 'Comment', '400')),
    ...[['702', 'removed-before-trash.txt'], ['703', 'source-metadata-only.txt'], ['704', 'intentionally-excluded.txt']].map(([id, filename]) =>
      object('Attachment', id, prop('title', filename) + prop('version', '1') + ref('containerContent', 'Page', '100') + prop('creationDate', '2020-01-02T00:00:00Z'))),
  ].join('') : '';
  const xml = `<hibernate-generic>${object('Space', '42', prop('key', 'SYN') + prop('name', 'Synthetic archive'))}${object('Page', '100', prop('title', 'Synthetic versioned page') + prop('version', withAuditFixtures ? '2' : '1') + ref('space', 'Space', '42') + prop('creationDate', '2020-01-01T00:00:00Z') + prop('lastModificationDate', '2020-01-02T00:00:00Z') + historical)}${object('BodyContent', '300', '<property name="body"><![CDATA[<p>보존한 문서 본문</p>]]></property>' + ref('content', 'Page', '100'))}${object('Attachment', '700', prop('title', 'report.bin') + prop('version', '2') + ref('containerContent', 'Page', '100') + '<collection name="historicalVersions"><element class="Attachment"><id name="id">701</id></element></collection>' + prop('creationDate', '2020-01-02T00:00:00Z'))}${object('Attachment', '701', prop('title', 'report.bin') + prop('version', '1') + ref('containerContent', 'Page', '100') + ref('originalVersion', 'Attachment', '700') + prop('creationDate', '2020-01-01T00:00:00Z'))}${extra}</hibernate-generic>`;
  const entries = [{ path: 'entities.xml', bytes: Buffer.from(xml) }, { path: 'attachments/100/700/1', bytes: first }, { path: 'attachments/100/700/2', bytes: latest }];
  if (withAuditFixtures) entries.push(
    { path: 'attachments/100/702/1', bytes: Buffer.from('삭제 전 독립 첨부') },
    { path: 'attachments/100/704/1', bytes: Buffer.from('의도적으로 이관에서 제외한 바이너리') },
  );
  return { first, latest, bytes: zip(entries) };
}

test('actual HTTP worker merges source containers into a new project, enforces review/actor/server IDs, rejects conflicts and suppresses outbound import events', async () => {
  const f = await fixture(); try {
    const endpoint = await f.call<WebhookEndpointCreated>('/webhook-endpoints', 'POST', { name: 'Synthetic no-network outbox', url: 'http://127.0.0.1:1/not-called', projectIds: null, eventTypes: ['issue.created', 'comment.created'] }); assert.equal(endpoint.status, 201); assert.equal((await f.call(`/webhook-endpoints/${endpoint.data.endpoint.id}`, 'PATCH', { expectedVersion: 1, enabled: true })).status, 200);
    const pkg = await f.upload(csv, 'migration.csv'), config = await f.configuration(pkg); assert.equal(config.projects.length, 2);
    assert.equal((await f.call('/migrations/preview', 'POST', { configuration: config }, 'missing-actor')).status, 400);
    const bad = structuredClone(config); bad.users[Object.keys(bad.users)[0]] = 'missing-user'; const blocked = await f.preview(bad); assert.equal(blocked.canApply, false); assert.equal((await f.apply(blocked)).status, 409);
    const plan = await f.preview(config); assert.equal(plan.canApply, true, JSON.stringify(plan.notices)); assert.equal(plan.projects.length, 1); assert.ok(plan.requiredAcknowledgements.length > 0);
    assert.equal((await f.apply(plan, {}, 'user-min')).status, 403); assert.equal((await f.apply(plan, { expectedVersion: 99 })).status, 409); assert.equal((await f.apply(plan, { acknowledgements: [] })).status, 400);
    const conflictConfig = structuredClone(config); conflictConfig.projects = conflictConfig.projects.map(value => ({ ...value, key: 'CONFLICT' })); const conflict = await f.preview(conflictConfig); assert.equal(conflict.canApply, true);
    assert.equal((await f.call('/projects', 'POST', { key: 'CONFLICT', name: 'Synthetic competing project' })).status, 201); assert.equal((await f.apply(conflict)).status, 409);
    const before = (await f.call<WorkspaceSnapshot>('/workspace')).data;
    // A stored preview from before original-link planning can still apply when no source bases were selected.
    f.db.prepare(`UPDATE migration_previews SET json=json_remove(json,'$.atlassianLinks',
      '$.preview.counts.atlassianLinks','$.preview.counts.unlinkedAtlassianRecords',
      '$.sourceImport.counts.atlassianLinks','$.sourceImport.counts.unlinkedAtlassianRecords') WHERE id=?`).run(plan.id);
    const applied = await f.apply(plan, { actorId: 'user-min', projects: [{ id: 'client-forged-project' }], issues: [{ id: 'client-forged-issue', title: 'forged' }] }); assert.equal(applied.status, 201, JSON.stringify(applied.data)); assert.equal(applied.data.duplicate, false); assert.equal(applied.data.import.actorId, 'user-seo'); assert.deepEqual(applied.data.import.notices, plan.notices);
    assert.equal(applied.data.import.counts.atlassianLinks, undefined);
    const after = (await f.call<WorkspaceSnapshot>('/workspace')).data, imported = after.issues.filter(value => applied.data.import.projectIds.includes(value.projectId)); assert.equal(after.projects.length, before.projects.length + 1); assert.equal(imported.length, 2); assert.ok(imported.every(value => /^[a-f\d-]{36}$/.test(value.id) && !value.id.startsWith('client-'))); assert.ok(!after.projects.some(value => value.id === 'client-forged-project'));
    const receipt = (await f.call<SourceImport[]>('/source-imports')).data[0]; assert.deepEqual(receipt.notices, plan.notices); const originals = (await f.call<SourceRecordPage>(`/source-imports/${plan.id}/records?kind=issue`)).data; assert.equal(originals.total, 2); assert.deepEqual(originals.records.map(value => value.record.sourceId).sort(), ['100', '200']);
    const duplicate = await f.apply(plan); assert.equal(duplicate.status, 200); assert.equal(duplicate.data.duplicate, true); assert.equal((await f.call<WorkspaceSnapshot>('/workspace')).data.issues.length, after.issues.length);
    const repeatedConfig = structuredClone(config); repeatedConfig.projects = repeatedConfig.projects.map(value => ({ ...value, key: 'SECOND' })); const repeated = await f.preview(repeatedConfig); assert.equal(repeated.canApply, false); assert.ok(repeated.notices.some(value => value.code === 'SOURCE_ALREADY_IMPORTED' && value.severity === 'error')); assert.equal((await f.apply(repeated)).status, 409); assert.equal((await f.call<SourceImport[]>('/source-imports')).data.length, 1); assert.deepEqual((await f.call('/webhook-deliveries')).data, []);
  } finally { await f.close(); }
});

test('mixed migration creates only reviewed original Jira and Confluence links without contacting their servers', async t => {
  const upstreamRequests: string[] = [];
  const upstream = createServer((request, response) => {
    upstreamRequests.push(`${request.method} ${request.url}`);
    response.writeHead(404).end();
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(async () => {
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  });
  const sourceOrigin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const jiraBase = `${sourceOrigin}/jira-app`;
  const wikiBase = `${sourceOrigin}/services/wiki`;
  const f = await fixture({ NODE_ENV: 'test', TEAMSPACE_JIRA_BASE_URL: jiraBase, TEAMSPACE_CONFLUENCE_BASE_URL: wikiBase });
  t.after(() => f.close());

  const headers = 'Issue id,Issue key,Project key,Summary,Created,Updated,Status,Issue Type';
  const issueRow = (id: string, key: string, title: string) =>
    `${id},${key},OLD,${title},2020-01-01T00:00:00Z,2020-01-02T00:00:00Z,Open,Task`;
  const issueTitle = 'Linked original issue';
  const missingKeyTitle = 'Unlinked issue with missing key';
  const missingBaseTitle = 'Unlinked issue with an unconfigured source';
  const excludedTitle = 'Excluded issue with valid origin';
  const pageTitle = 'Synthetic versioned page';
  const jira = await f.upload(Buffer.from([headers, issueRow('100', 'old-7', issueTitle),
    issueRow('101', '', missingKeyTitle), issueRow('102', 'OLD-9', excludedTitle)].join('\r\n')), 'linked-origin.csv', 'jira');
  const unconfigured = await f.upload(Buffer.from([headers, issueRow('100', 'old-7', missingBaseTitle)].join('\r\n')), 'unconfigured-origin.csv', 'jira');
  const confluenceArchive = await f.upload(confluence().bytes, 'linked-origin.zip', 'confluence');
  const config = await f.configuration([jira, unconfigured, confluenceArchive], 'ORIGINS');
  for (const type of Object.keys(config.issueTypes)) config.issueTypes[type] = '작업';
  config.sourceBaseUrls[jira.id] = `${jiraBase}/`;
  config.sourceBaseUrls[confluenceArchive.id] = wikiBase;
  config.excludedRecords = [`${jira.id}/issue:102`];

  const jiraUrl = `${jiraBase}/browse/OLD-7`;
  const wikiUrl = `${wikiBase}/pages/viewpage.action?pageId=100`;
  const readStoredLinks = async (targetType: AtlassianLinkTarget, targetId: string) => {
    const result = await f.call<AtlassianLink[]>(`/atlassian-links?${new URLSearchParams({ targetType, targetId })}`);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  };
  const countStoredLinks = () => f.db.prepare('SELECT COUNT(*) AS total FROM atlassian_links').get()?.total;

  const stale = await f.preview(config);
  assert.equal(stale.canApply, true, JSON.stringify(stale.notices));
  f.db.prepare(`UPDATE migration_previews SET json=json_remove(json,'$.atlassianLinks',
    '$.preview.counts.atlassianLinks','$.preview.counts.unlinkedAtlassianRecords',
    '$.sourceImport.counts.atlassianLinks','$.sourceImport.counts.unlinkedAtlassianRecords') WHERE id=?`).run(stale.id);
  const rejected = await f.apply(stale);
  assert.equal(rejected.status, 409, JSON.stringify(rejected.data));
  assert.match(JSON.stringify(rejected.data), /미리보기/);
  assert.deepEqual((await f.call('/source-imports')).data, []);
  assert.equal(countStoredLinks(), 0);

  const plan = await f.preview(config);
  assert.equal(plan.canApply, true, JSON.stringify(plan.notices));
  assert.equal(plan.counts.atlassianLinks, 2);
  assert.equal(plan.counts.unlinkedAtlassianRecords, 2);
  assert.ok(plan.notices.some(notice => notice.code === 'SOURCE_LINK_LOCATOR_UNAVAILABLE' && notice.recordId === `${jira.id}/issue:101`));
  assert.ok(plan.notices.some(notice => notice.code === 'SOURCE_LINK_BASE_MISSING' && notice.message.includes(unconfigured.filename)));
  assert.equal(plan.samples.find(sample => sample.title === issueTitle)?.sourceUrl, jiraUrl);
  assert.equal(plan.samples.find(sample => sample.title === pageTitle)?.sourceUrl, wikiUrl);
  assert.ok(!plan.samples.find(sample => sample.title === missingKeyTitle)?.sourceUrl);
  assert.ok(!plan.samples.find(sample => sample.title === missingBaseTitle)?.sourceUrl);
  assert.ok(!plan.samples.some(sample => sample.title === excludedTitle));
  assert.equal(countStoredLinks(), 0);
  assert.deepEqual(upstreamRequests, []);

  const applied = await f.apply(plan, { atlassianLinks: [{ url: `${sourceOrigin}/forged` }] });
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  const receipt = applied.data.import;
  assert.equal(receipt.counts.atlassianLinks, 2);
  assert.equal(receipt.counts.unlinkedAtlassianRecords, 2);
  assert.deepEqual(receipt.notices, plan.notices);
  const current = (await f.call<WorkspaceSnapshot>('/workspace')).data;
  const issue = current.issues.find(item => item.title === issueTitle);
  const document = current.documents.find(item => item.title === pageTitle);
  const missingKey = current.issues.find(item => item.title === missingKeyTitle);
  const missingBase = current.issues.find(item => item.title === missingBaseTitle);
  assert.ok(issue && document && missingKey && missingBase);
  assert.notEqual(issue.key, 'OLD-7');
  assert.ok(!current.issues.some(item => item.title === excludedTitle));
  const excluded = (await f.call<SourceRecordPage>(`/source-imports/${receipt.id}/records?kind=issue`)).data.records.find(item => item.record.title === excludedTitle);
  assert.ok(excluded);
  assert.equal(excluded.targetId, null);
  const canonicalJira = await readStoredLinks('issue', issue.id);
  const canonicalWiki = await readStoredLinks('document', document.id);
  assert.deepEqual(canonicalJira.map(({ product, url }) => ({ product, url })), [{ product: 'jira', url: jiraUrl }]);
  assert.deepEqual(canonicalWiki.map(({ product, url }) => ({ product, url })), [{ product: 'confluence', url: wikiUrl }]);
  assert.deepEqual(await readStoredLinks('issue', missingKey.id), []);
  assert.deepEqual(await readStoredLinks('issue', missingBase.id), []);

  const repeated = await f.apply(plan);
  assert.equal(repeated.status, 200);
  assert.deepEqual(repeated.data, { import: receipt, duplicate: true });
  assert.deepEqual(await readStoredLinks('issue', issue.id), canonicalJira);
  assert.deepEqual(await readStoredLinks('document', document.id), canonicalWiki);
  const backup = (await f.call<{ schemaVersion: number; atlassianLinks: AtlassianLink[] }>('/export')).data;
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.equal(backup.atlassianLinks.length, 2);
  assert.deepEqual(new Set(backup.atlassianLinks.map(link => link.url)), new Set([jiraUrl, wikiUrl]));
  assert.equal((await f.call('/import', 'POST', { data: backup })).status, 200);
  assert.deepEqual(await readStoredLinks('issue', issue.id), canonicalJira);
  assert.deepEqual(await readStoredLinks('document', document.id), canonicalWiki);
  assert.deepEqual((await f.call<SourceImport[]>('/source-imports')).data[0].counts, receipt.counts);
  assert.deepEqual(upstreamRequests, []);
});

test('actual ZIP attachment versions survive native9 exact downloads and migration audit/save/install failures roll back database and files', async t => {
  const f = await fixture(), binary = confluence(); try {
    const pkg = await f.upload(binary.bytes, 'confluence.zip', 'confluence'), config = await f.configuration(pkg);
    config.sourceBaseUrls[pkg.id] = 'https://archive.example.test/wiki';
    const plan = await f.preview(config); assert.equal(plan.canApply, true, JSON.stringify(plan.notices)); assert.equal(plan.counts.attachmentVersions, 2); assert.equal(plan.counts.atlassianLinks, 1);
    const existingBytes = Buffer.from('unrelated existing fixture file'), upload = await fetch(`${f.base}/attachments?resourceType=issue&resourceId=issue-2&filename=existing.bin`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': 'user-seo' }, body: existingBytes }); assert.equal(upload.status, 201); const existing = await upload.json() as Attachment;
    const before = (await f.call<WorkspaceSnapshot>('/workspace')).data, names = readdirSync(join(f.dir, 'uploads')).sort();
    const unchanged = async () => { assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).data, before); assert.deepEqual((await f.call('/source-imports')).data, []); assert.equal(f.db.prepare('SELECT COUNT(*) AS total FROM atlassian_links').get()?.total, 0); assert.deepEqual(readdirSync(join(f.dir, 'uploads')).sort(), names); assert.deepEqual(readFileSync(join(f.dir, 'uploads', existing.id)), existingBytes); assert.ok(!readdirSync(f.dir).some(value => value.startsWith('.append-'))); };
    f.db.exec("CREATE TRIGGER synthetic_migration_audit BEFORE INSERT ON activities WHEN json_extract(NEW.json,'$.action')='원본 이관 적용' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;");
    assert.equal((await f.apply(plan)).status, 500); f.db.exec('DROP TRIGGER synthetic_migration_audit'); await unchanged();
    f.db.exec("CREATE TRIGGER synthetic_migration_save BEFORE INSERT ON documents WHEN json_extract(NEW.json,'$.title')='Synthetic versioned page' BEGIN SELECT RAISE(ABORT,'synthetic save failure'); END;");
    assert.equal((await f.apply(plan)).status, 500); f.db.exec('DROP TRIGGER synthetic_migration_save'); await unchanged();
    f.db.exec("CREATE TRIGGER synthetic_migration_link BEFORE INSERT ON atlassian_links BEGIN SELECT RAISE(ABORT,'synthetic link failure'); END;");
    assert.equal((await f.apply(plan)).status, 500); f.db.exec('DROP TRIGGER synthetic_migration_link'); await unchanged();
    const stage = AttachmentAppend.prototype.stage;
    const installedFailure = t.mock.method(AttachmentAppend.prototype, 'stage', function (this: AttachmentAppend, id: string, files: AppendedFile[]) { const result = stage.call(this, id, files); return { ...result, install() { result.install(); throw new Error('synthetic failure after install'); } }; });
    assert.equal((await f.apply(plan)).status, 500); installedFailure.mock.restore(); await unchanged();
    const applied = await f.apply(plan); assert.equal(applied.status, 201, JSON.stringify(applied.data));
    const workspace = (await f.call<WorkspaceSnapshot>('/workspace')).data, document = workspace.documents.find(value => applied.data.import.projectIds.includes(value.projectId || ''))!; assert.ok(document);
    const files = (await f.call<Attachment[]>(`/attachments?resourceType=document&resourceId=${document.id}`)).data; assert.equal(files.length, 1); const versions = (await f.call<AttachmentVersion[]>(`/attachments/${files[0].id}/versions`)).data; assert.equal(versions.length, 2);
    async function exactDownloads() { for (const version of versions) { const response = await fetch(`${f.base}/attachment-versions/${version.id}/download`); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/octet-stream'); assert.deepEqual(Buffer.from(await response.arrayBuffer()), version.versionLabel === '1' ? binary.first : binary.latest); } }
    await exactDownloads();
    const backup = (await f.call<Record<string, unknown>>('/export')).data; assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION); assert.equal((backup.attachmentVersions as unknown[]).length, 2); assert.equal((backup.attachmentContents as unknown[]).length, 3);
    const invalidNotice = structuredClone(backup); (invalidNotice.sourceImports as SourceImport[])[0].notices = [{ severity: 'error', code: 'SYNTHETIC_BLOCKER', message: '완료된 영수증에 오류를 넣을 수 없음', recordId: null, requiresAcknowledgement: false }]; assert.equal((await f.call('/import', 'POST', { data: invalidNotice })).status, 400); await exactDownloads();
    const invalid = structuredClone(backup); (invalid.resourceLinks as { documentId: string }[])[0].documentId = 'synthetic-missing-document'; const snapshot = (await f.call<WorkspaceSnapshot>('/workspace')).data;
    assert.equal((await f.call('/import', 'POST', { data: invalid })).status, 404); assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).data, snapshot); await exactDownloads();
    assert.equal((await f.call('/import', 'POST', { data: backup })).status, 200); await exactDownloads();
    const after = (await f.call<SourceImport[]>('/source-imports')).data[0]; assert.equal(after.version, 2); assert.deepEqual(after.notices, plan.notices);
    const archives = (await f.call<SourceRecordPage>(`/source-imports/${plan.id}/records?kind=attachment`)).data; assert.equal(archives.total, 2); const archive = (await f.call<SourceRecordArchive>(`/source-imports/${plan.id}/records/${archives.records[0].id}`)).data; assert.equal(archive.record.kind, 'attachment');

    const root = files[0].id;
    const localBytes = Buffer.from('현지 팀에서 추가한 합성 버전');
    const localUpload = await fetch(`${f.base}/attachments/${root}/versions?${new URLSearchParams({ expectedVersionId: root, filename: 'updated.bin' })}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': 'user-min' }, body: new Uint8Array(localBytes),
    });
    const local = await localUpload.json() as AttachmentHead;
    assert.equal(localUpload.status, 201, JSON.stringify(local));
    assert.equal(local.id, root);
    assert.notEqual(local.currentVersionId, root);
    assert.equal(local.versionCount, 3);
    const historyWithLocal = (await f.call<AttachmentVersion[]>(`/attachments/${root}/versions`)).data;
    assert.equal(historyWithLocal[0].id, local.currentVersionId);
    assert.equal(historyWithLocal[0].localRevision, 2);
    assert.equal(historyWithLocal[0].sourceImportId, null);
    assert.deepEqual(historyWithLocal.slice(1), versions);
    const preservedRoot = await fetch(`${f.base}/attachments/${root}/content`);
    assert.equal(preservedRoot.status, 200);
    assert.deepEqual(Buffer.from(await preservedRoot.arrayBuffer()), binary.latest);
    await exactDownloads();

    const withLocal = (await f.call<Record<string, unknown>>('/export')).data;
    assert.equal((await f.call('/import', 'POST', { data: withLocal })).status, 200);
    assert.deepEqual((await f.call<AttachmentVersion[]>(`/attachments/${root}/versions`)).data, historyWithLocal);
    assert.deepEqual((await f.call<SourceRecordPage>(`/source-imports/${plan.id}/records?kind=attachment`)).data, archives);
    const localBytesAgain = await fetch(`${f.base}/attachments/${local.currentVersionId}/content`);
    assert.equal(localBytesAgain.status, 200);
    assert.deepEqual(Buffer.from(await localBytesAgain.arrayBuffer()), localBytes);
    await exactDownloads();
  } finally { await f.close(); }
});

test('Confluence XML worker imports remote page attachments by original owner and downloads exact linked bytes after native restore', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const prop = (name: string, value: string) => `<property name="${name}">${value}</property>`;
  const ref = (name: string, type: string, id: string) => `<property name="${name}" class="${type}"><id name="id">${id}</id></property>`;
  const object = (type: string, id: string, children: string) => `<object class="${type}"><id name="id">${id}</id>${children}</object>`;
  const date = prop('creationDate', '2020-01-02T00:00:00Z');
  const file = (id: string, owner: string, filename: string, version: string, history: string) =>
    object('Attachment', id, prop('title', filename) + prop('version', version) + ref('containerContent', 'Page', owner) + date + history);
  const projectPage = (id: string, space: string) => object('Page', id, prop('title', '원본 현황') + prop('version', '1') + ref('space', 'Space', space) + date);
  const storage = [
    '<p>파일을 참조하는 원본</p>',
    '<ac:image ac:alt="원격 소유 PNG"><ri:attachment ri:filename="shared.png"><ri:page ri:space-key="QA" ri:content-title="원본 현황"/></ri:attachment></ac:image>',
    '<p><ac:link><ri:attachment ri:filename="report.bin" ri:content-id="721"><ri:content-entity ri:content-id="200"/></ri:attachment><ac:link-body>원격 예전 보고서</ac:link-body></ac:link></p>',
    '<ac:image ac:alt="누락된 소유 PNG"><ri:attachment ri:filename="shared.png"><ri:page ri:space-key="ABSENT" ri:content-title="원본 현황"/></ri:attachment></ac:image>',
    '<p><ac:link><ri:attachment ri:filename="report.bin" ri:content-id="701"><ri:content-entity ri:content-id="200"/></ri:attachment><ac:link-body>잘못된 소유 보고서</ac:link-body></ac:link></p>',
  ].join('');
  const xml = `<hibernate-generic>${[
    object('Space', '20', prop('key', 'OPS') + prop('name', '원본 업무 공간')),
    object('Space', '30', prop('key', 'QA') + prop('name', '원본 검증 공간')),
    projectPage('100', '20'), projectPage('200', '30'),
    object('BodyContent', '500', prop('body', `<![CDATA[${storage}]]>`) + ref('content', 'Page', '100')),
    file('700', '100', 'shared.png', '1', ''),
    file('701', '100', 'report.bin', '1', ''),
    file('710', '200', 'shared.png', '1', ''),
    file('720', '200', 'report.bin', '2', '<collection name="historicalVersions"><element class="Attachment"><id name="id">721</id></element></collection>'),
    file('721', '200', 'report.bin', '1', ref('originalVersion', 'Attachment', '720')),
  ].join('')}</hibernate-generic>`;
  const localPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+2TmcAAAAASUVORK5CYII=', 'base64');
  const remotePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNgYGD4DwABBAEAMHhqrQAAAABJRU5ErkJggg==', 'base64');
  const oldReport = Buffer.from('원격 보고서의 예전 버전\x00\n');
  const pack = await f.upload(zip([
    { path: 'entities.xml', bytes: Buffer.from(xml) },
    { path: 'attachments/100/700/1', bytes: localPng },
    { path: 'attachments/100/701/1', bytes: Buffer.from('같은 이름의 로컬 보고서') },
    { path: 'attachments/200/710/1', bytes: remotePng },
    { path: 'attachments/200/720/1', bytes: oldReport },
    { path: 'attachments/200/720/2', bytes: Buffer.from('원격 보고서의 현재 버전') },
  ]), 'confluence-remote-owner.zip', 'confluence');
  const configuration = await f.configuration(pack);
  configuration.sourceBaseUrls[pack.id] = 'https://wiki.example.test/confluence';
  const previous = await f.preview(configuration);
  assert.equal(previous.canApply, true, JSON.stringify(previous.notices));
  f.db.prepare("UPDATE migration_previews SET json=json_remove(json,'$.conversionVersion') WHERE id=?").run(previous.id);
  assert.equal((await f.apply(previous)).status, 409);
  const preview = await f.preview(configuration);
  assert.equal(preview.canApply, true, JSON.stringify(preview.notices));
  assert.ok(preview.notices.some(notice => notice.code === 'UNRESOLVED_IMAGE' && notice.recordId === `${pack.id}/page:100`));
  assert.ok(preview.notices.some(notice => notice.code === 'UNRESOLVED_ATTACHMENT' && notice.recordId === `${pack.id}/page:100`));
  const applied = await f.apply(preview);
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  const receipt = applied.data.import;

  async function checkBindingsAndDownloads() {
    const recordsPath = `/source-imports/${receipt.id}/records`;
    const originals = await f.call<SourceRecordPage>(recordsPath);
    assert.equal(originals.status, 200);
    const archive = (id: string) => originals.data.records.find(row => row.record.id === id)!;
    const sourcePage = archive('page:100');
    const localFile = archive('attachment:700');
    const remoteFile = archive('attachment:710');
    const historicalReport = archive('attachment:721');
    const currentReport = archive('attachment:720');
    const remoteDocument = archive('page:200');
    assert.ok(sourcePage?.targetId && localFile?.targetId && remoteFile?.targetId && historicalReport?.targetId && currentReport?.targetId && remoteDocument?.targetId);
    assert.equal(localFile.ownerId, sourcePage.targetId);
    assert.equal(remoteFile.ownerId, remoteDocument.targetId);
    assert.equal(historicalReport.ownerId, remoteDocument.targetId);
    assert.notEqual(historicalReport.targetId, currentReport.targetId);

    const workspace = await f.call<WorkspaceSnapshot>('/workspace');
    assert.equal(workspace.status, 200);
    const source = workspace.data.documents.find(document => document.id === sourcePage.targetId)!;
    const images: Array<RichContent['attrs']> = [];
    const links: unknown[] = [];
    const pending = [source.content];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.type === 'image') images.push(node.attrs);
      for (const mark of node.marks ?? []) if (mark.type === 'link') links.push(mark.attrs?.href);
      pending.push(...node.content ?? []);
    }
    const imageUrl = `/api/attachments/${remoteFile.targetId}/content?inline=1`;
    const versionUrl = `/api/attachments/${historicalReport.targetId}/content`;
    assert.deepEqual(images.map(image => [image?.src, image?.alt]), [[imageUrl, '원격 소유 PNG']]);
    assert.deepEqual(links, [versionUrl]);
    assert.match(source.plainText, /\[이미지: 누락된 소유 PNG\]/);
    assert.match(source.plainText, /\[첨부: 잘못된 소유 보고서\]/);
    const original = await f.call<SourceRecordArchive>(`${recordsPath}/${sourcePage.id}`);
    assert.equal(original.status, 200);
    assert.equal(original.data.record.text, storage);

    const version = await fetch(new URL(versionUrl, f.base));
    assert.equal(version.status, 200);
    assert.match(version.headers.get('Content-Disposition') || '', /^attachment;/);
    assert.deepEqual(Buffer.from(await version.arrayBuffer()), oldReport);
    const image = await fetch(new URL(imageUrl, f.base));
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('Content-Type'), 'image/png');
    assert.match(image.headers.get('Content-Disposition') || '', /^inline;/);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), remotePng);
    return source.content;
  }

  const before = await checkBindingsAndDownloads();
  const backup = await f.call('/export');
  assert.equal(backup.status, 200);
  assert.equal((await f.call('/import', 'POST', { data: backup.data })).status, 200);
  assert.deepEqual(await checkBindingsAndDownloads(), before);
});

test('reconciliation and the whole-receipt audit follow exact migrated attachment versions through corruption, trash, native restore, and deletion', async t => {
  const f = await fixture(), binary = confluence(true);
  try {
    const pkg = await f.upload(binary.bytes, 'reconciliation.zip', 'confluence');
    const config = await f.configuration(pkg);
    config.excludedRecords = [`${pkg.id}/attachment:704`];
    const plan = await f.preview(config);
    assert.equal(plan.canApply, true, JSON.stringify(plan.notices));
    const applied = await f.apply(plan);
    assert.equal(applied.status, 201, JSON.stringify(applied.data));
    const receipt = applied.data.import;
    const auditPath = `/source-imports/${receipt.id}/reconciliation`;
    const fullPath = (version = receipt.version) => `${auditPath}/audit?expectedVersion=${version}`;
    async function audit(query = '') {
      const result = await f.call<SourceReconciliationPage>(auditPath + query);
      assert.equal(result.status, 200, JSON.stringify(result.data));
      assert.equal(result.data.importId, receipt.id);
      return result.data;
    }
    async function fullAudit(version = receipt.version) {
      const result = await f.call<SourceReconciliationAudit>(fullPath(version));
      assert.equal(result.status, 200, JSON.stringify(result.data));
      assert.equal(result.data.importId, receipt.id);
      assert.equal(result.data.receiptVersion, version);
      assert.ok(Date.parse(result.data.startedAt) <= Date.parse(result.data.completedAt));
      assert.equal(result.data.attachments.length, Object.values(result.data.attachmentCounts).reduce((sum, count) => sum + count, 0));
      return result.data;
    }
    const initial = await audit();
    assert.equal(initial.receiptVersion, receipt.version);
    assert.equal(initial.total, receipt.counts.sourceRecords);
    assert.equal(initial.total, Object.values(initial.counts).reduce((sum, count) => sum + count, 0));
    assert.doesNotMatch(JSON.stringify(initial), /보존한 문서 본문|보존한 원본 댓글/);

    const document = initial.rows.find(row => row.kind === 'page');
    const related = initial.rows.filter(row => row.kind === 'revision' || row.kind === 'comment');
    const versionRows = initial.rows.filter(row => row.kind === 'attachment');
    const older = versionRows.find(row => row.sourceId === '701');
    const newer = versionRows.find(row => row.sourceId === '700');
    const removed = versionRows.find(row => row.sourceId === '702');
    const archiveOnly = versionRows.find(row => row.sourceId === '703');
    const excluded = versionRows.find(row => row.sourceId === '704');
    assert.ok(document?.target && older?.target && newer?.target && removed?.target && archiveOnly && excluded);
    const documentId = document.target.id;
    const archivedTogether = [document, older, newer, ...related];
    assert.deepEqual(related.map(row => row.kind).sort(), ['comment', 'revision']);
    assert.ok(archivedTogether.every(row => row.status === 'linked'));
    assert.ok([older, newer, removed, ...related].every(row => row.target?.owner?.id === documentId));
    assert.equal(archiveOnly.status, 'archive-only');
    assert.equal(archiveOnly.target, null);

    const checkFilePath = (sourceRecordId: string) => `/source-imports/${receipt.id}/records/${sourceRecordId}/check-file`;
    async function checkFile(sourceRecordId: string) {
      const checked = await f.call<SourceReconciliationFileCheck>(checkFilePath(sourceRecordId));
      assert.equal(checked.status, 200, JSON.stringify(checked.data));
      assert.equal(checked.data.sourceRecordId, sourceRecordId);
      return checked.data;
    }
    assert.equal((await f.call(checkFilePath(document.sourceRecordId))).status, 400);
    assert.equal((await checkFile(archiveOnly.sourceRecordId)).status, 'unbound');
    const expectedOlder = { sourceRecordId: older.sourceRecordId, status: 'verified', fileId: older.target.id, size: binary.first.length, sha256: hash(binary.first) };
    assert.deepEqual(await checkFile(older.sourceRecordId), expectedOlder);
    assert.equal((await checkFile(newer.sourceRecordId)).sha256, hash(binary.latest));

    assert.equal(excluded.status, 'excluded');
    const untouchedWorkspace = (await f.call<WorkspaceSnapshot>('/workspace')).data;
    const clean = await fullAudit();
    const cleanOlder = clean.attachments.find(row => row.sourceRecordId === older.sourceRecordId);
    assert.deepEqual(clean.recordCounts, initial.counts);
    assert.deepEqual(clean.attachmentCounts, { verified: 3, missing: 0, corrupt: 0, unbound: 1, excluded: 1, unreadable: 0 });
    assert.deepEqual(cleanOlder, {
      ...expectedOlder, sourceId: '701', title: 'report.bin', product: 'confluence', recordStatus: 'linked',
      sourceInstance: pkg.source.instanceKey, packageSha256: pkg.sha256,
    });
    assert.equal(clean.attachments.find(row => row.sourceRecordId === newer.sourceRecordId)?.sha256, hash(binary.latest));
    assert.equal(clean.attachments.find(row => row.sourceRecordId === excluded.sourceRecordId)?.status, 'excluded');
    assert.equal(clean.attachments.find(row => row.sourceRecordId === archiveOnly.sourceRecordId)?.status, 'unbound');
    assert.doesNotMatch(JSON.stringify(clean), /보존한 문서 본문|보존한 원본 댓글/);
    assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).data, untouchedWorkspace);
    assert.deepEqual((await f.call<SourceImport[]>('/source-imports')).data.find(value => value.id === receipt.id), receipt);

    const olderPath = join(f.dir, 'uploads', older.target.id);
    const corrupted = Buffer.from(binary.first);
    corrupted[0] ^= 1;
    try {
      writeFileSync(olderPath, corrupted);
      assert.deepEqual(await checkFile(older.sourceRecordId), { ...expectedOlder, status: 'corrupt' });
      const mixed = await fullAudit();
      assert.deepEqual(mixed.attachmentCounts, { ...clean.attachmentCounts, verified: 2, corrupt: 1 });
      assert.equal(mixed.attachments.find(row => row.sourceRecordId === older.sourceRecordId)?.recordStatus, 'linked');
      rmSync(olderPath);
      assert.deepEqual(await checkFile(older.sourceRecordId), { ...expectedOlder, status: 'missing' });
      assert.deepEqual((await fullAudit()).attachmentCounts, { ...clean.attachmentCounts, verified: 2, missing: 1 });
      assert.equal((await checkFile(newer.sourceRecordId)).status, 'verified');
      assert.equal((await audit()).rows.find(row => row.sourceRecordId === older.sourceRecordId)?.status, 'linked');
    } finally { writeFileSync(olderPath, binary.first); }

    const versionRow = f.db.prepare('SELECT json FROM attachment_versions WHERE id=?').get(older.target.id);
    assert.ok(versionRow && typeof versionRow.json === 'string');
    const updateVersion = f.db.prepare('UPDATE attachment_versions SET json=? WHERE id=?');
    try {
      writeFileSync(olderPath, corrupted);
      updateVersion.run(JSON.stringify({ ...(JSON.parse(versionRow.json) as AttachmentVersion), sha256: hash(corrupted) }), older.target.id);
      assert.equal((await checkFile(older.sourceRecordId)).status, 'verified');
      assert.equal((await fullAudit()).attachments.find(row => row.sourceRecordId === older.sourceRecordId)?.status, 'corrupt');
    } finally {
      updateVersion.run(versionRow.json, older.target.id);
      writeFileSync(olderPath, binary.first);
    }

    const open = fileSystem.open;
    const unreadable = t.mock.method(fileSystem, 'open', async (...args: Parameters<typeof open>) => {
      if (String(args[0]) === olderPath) throw Object.assign(new Error('synthetic access failure'), { code: 'EACCES' });
      return open(...args);
    });
    try {
      const report = await fullAudit();
      assert.deepEqual(report.attachmentCounts, { ...clean.attachmentCounts, verified: 2, unreadable: 1 });
      assert.equal(report.attachments.find(row => row.sourceRecordId === older.sourceRecordId)?.status, 'unreadable');
      assert.doesNotMatch(JSON.stringify(report), /synthetic access failure/);
    } finally { unreadable.mock.restore(); }

    const allMatches = await audit('?kind=attachment&status=linked&q=report.bin');
    assert.equal(allMatches.total, 2);
    for (const offset of [0, 1]) {
      const page = await audit(`?kind=attachment&status=linked&q=report.bin&limit=1&offset=${offset}`);
      assert.equal(page.total, 2);
      assert.equal(page.offset, offset);
      assert.equal(page.limit, 1);
      assert.deepEqual(page.counts, initial.counts);
      assert.deepEqual(page.rows, [allMatches.rows[offset]]);
    }
    for (const invalid of ['?limit=0', '?limit=101', '?status=unknown', '?offset=1&offset=2', '?unexpected=true']) {
      assert.equal((await f.call(auditPath + invalid)).status, 400, invalid);
    }
    assert.equal((await f.call(`/source-imports/${randomUUID()}/reconciliation`)).status, 404);
    assert.equal((await f.call(`/source-imports/${randomUUID()}/reconciliation/audit?expectedVersion=1`)).status, 404);
    assert.equal((await f.call(`${auditPath}/audit`)).status, 400);
    assert.equal((await f.call(`${fullPath()}&expectedVersion=2`)).status, 400);
    assert.equal((await f.call(checkFilePath(randomUUID()))).status, 404);

    const key = await f.call<ApiKeyCreated>('/api-keys', 'POST', { name: 'Synthetic project read key', access: 'read', projectIds: receipt.projectIds, expiresAt: null });
    assert.equal(key.status, 201, JSON.stringify(key.data));
    for (const path of [auditPath, checkFilePath(older.sourceRecordId), fullPath()]) {
      const response = await fetch(`${f.base}/v1${path}`, { headers: { Authorization: `Bearer ${key.data.token}` } });
      assert.equal(response.status, 403, path);
      await response.body?.cancel();
    }

    const canonical = await f.call<WorkspaceSnapshot>('/workspace');
    const currentDoc = canonical.data.documents.find(value => value.id === documentId)!;
    const pause = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let intercepted = false;
    const mockedOpen = t.mock.method(fileSystem, 'open', async (...args: Parameters<typeof open>) => {
      if (!intercepted && String(args[0]) === olderPath) {
        intercepted = true;
        pause.resolve();
        await release.promise;
      }
      return open(...args);
    });
    const pending = f.call(fullPath());
    let destination: DocPage;
    try {
      assert.equal(await Promise.race([pause.promise.then(() => true), pending.then(() => false)]), true, 'audit paused at the live attachment read');
      assert.equal((await f.call(fullPath())).status, 429);
      const moved = await f.call<DocPage>(`/documents/${documentId}`, 'PATCH', { projectId: 'project-neo', expectedVersion: currentDoc.version });
      assert.equal(moved.status, 200, JSON.stringify(moved.data));
      destination = moved.data;
      release.resolve();
      assert.equal((await pending).status, 409);
    } finally {
      release.resolve();
      mockedOpen.mock.restore();
      await pending;
    }
    const movedAudit = await audit();
    assert.equal(movedAudit.rows.find(row => row.sourceRecordId === document.sourceRecordId)?.target?.projectId, destination.projectId);
    assert.equal(movedAudit.rows.find(row => row.sourceRecordId === older.sourceRecordId)?.target?.owner?.projectId, destination.projectId);

    const versionArchive = await f.call<{ trashItemId: string }>(`/attachments/${newer.target.id}`, 'DELETE');
    assert.equal(versionArchive.status, 200, JSON.stringify(versionArchive.data));
    assert.deepEqual(new Set((await audit('?status=trashed')).rows.map(row => row.sourceRecordId)), new Set([older.sourceRecordId, newer.sourceRecordId]));
    assert.deepEqual(await checkFile(older.sourceRecordId), expectedOlder);
    const versionedFiles = new Set([older.target.id, newer.target.id]);
    const archivedVersions = (await fullAudit()).attachments.filter(row => row.fileId && versionedFiles.has(row.fileId));
    assert.equal(archivedVersions.length, 2);
    assert.ok(archivedVersions.every(row => row.recordStatus === 'trashed' && row.status === 'verified'));
    assert.equal((await f.call(`/trash/items/${versionArchive.data.trashItemId}/restore`, 'POST')).status, 200);
    assert.equal((await audit('?status=trashed')).total, 0);

    const commentSource = related.find(row => row.kind === 'comment')!;
    const commentsPath = `/comments?resourceType=document&resourceId=${documentId}`;
    const comment = (await f.call<Comment[]>(commentsPath)).data.find(row => row.id === commentSource.target?.id)!;
    assert.ok(comment);
    const commentArchive = await f.call<{ trashItemId: string }>(`/comments/${comment.id}`, 'DELETE', undefined, comment.authorId);
    const attachmentArchive = await f.call<{ trashItemId: string }>(`/attachments/${removed.target.id}`, 'DELETE');
    assert.equal(commentArchive.status, 200, JSON.stringify(commentArchive.data));
    assert.equal(attachmentArchive.status, 200, JSON.stringify(attachmentArchive.data));
    const individual = await audit('?status=trashed');
    assert.deepEqual(new Set(individual.rows.map(row => row.sourceRecordId)), new Set([commentSource.sourceRecordId, removed.sourceRecordId]));
    assert.ok(individual.rows.every(row => row.target?.owner?.projectId === destination.projectId));
    assert.equal((await checkFile(removed.sourceRecordId)).status, 'verified');

    const trashed = await f.call<{ trashEntryId: string }>(`/documents/${documentId}`, 'DELETE');
    assert.equal(trashed.status, 200, JSON.stringify(trashed.data));
    const trashAudit = await audit('?status=trashed');
    assert.deepEqual(new Set(trashAudit.rows.map(row => row.sourceRecordId)), new Set([...archivedTogether, removed].map(row => row.sourceRecordId)));
    assert.equal((await audit('?status=missing')).total, 0);
    assert.deepEqual(await checkFile(older.sourceRecordId), expectedOlder);
    const fullTrash = await fullAudit();
    assert.deepEqual(fullTrash.recordCounts, trashAudit.counts);
    assert.deepEqual(fullTrash.attachmentCounts, clean.attachmentCounts);
    assert.ok([older, newer, removed].every(value => fullTrash.attachments.some(row => row.sourceRecordId === value.sourceRecordId && row.recordStatus === 'trashed' && row.status === 'verified')));

    const backup = await f.call('/export');
    assert.equal(backup.status, 200);
    assert.equal((await f.call('/import', 'POST', { data: backup.data })).status, 200);
    const sameArchived = await audit('?status=trashed');
    assert.equal(sameArchived.receiptVersion, receipt.version + 1);
    assert.deepEqual(sameArchived.rows, trashAudit.rows);
    assert.deepEqual(await checkFile(older.sourceRecordId), expectedOlder);
    assert.equal((await f.call(fullPath())).status, 409);
    assert.deepEqual((await fullAudit(sameArchived.receiptVersion)).attachments, fullTrash.attachments);

    assert.equal((await f.call(`/trash/${trashed.data.trashEntryId}/restore`, 'POST')).status, 200);
    const stillArchived = await audit('?status=trashed');
    assert.deepEqual(new Set(stillArchived.rows.map(row => row.sourceRecordId)), new Set([commentSource.sourceRecordId, removed.sourceRecordId]));
    assert.equal((await f.call(`/trash/items/${commentArchive.data.trashItemId}/restore`, 'POST')).status, 200);
    assert.equal((await f.call(`/trash/items/${attachmentArchive.data.trashItemId}`, 'DELETE')).status, 200);
    assert.equal((await audit('?status=trashed')).total, 0);
    const restored = await audit();
    assert.ok(archivedTogether.every(original => restored.rows.find(row => row.sourceRecordId === original.sourceRecordId)?.status === 'linked'));
    assert.deepEqual((await f.call<Comment[]>(commentsPath)).data.find(row => row.id === comment.id), comment);
    assert.equal((await checkFile(removed.sourceRecordId)).status, 'missing');
    const trashedAgain = await f.call<{ trashEntryId: string }>(`/documents/${documentId}`, 'DELETE');
    assert.equal(trashedAgain.status, 200);
    assert.equal((await f.call(`/trash/${trashedAgain.data.trashEntryId}`, 'DELETE')).status, 200);
    assert.deepEqual(new Set((await audit('?status=missing')).rows.map(row => row.sourceRecordId)), new Set([...archivedTogether, removed].map(row => row.sourceRecordId)));
    assert.equal((await checkFile(older.sourceRecordId)).status, 'missing');
    assert.equal((await checkFile(archiveOnly.sourceRecordId)).status, 'unbound');
    assert.deepEqual((await fullAudit(restored.receiptVersion)).attachmentCounts, { ...clean.attachmentCounts, verified: 0, missing: 3 });
  } finally { await f.close(); }
});

test('retained source verification distinguishes archival loss from deleted live targets and intentional exclusions', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const jira = await f.upload(csv, 'integrity-jira.csv', 'jira');
  const wiki = await f.upload(confluence(true).bytes, 'integrity-confluence.zip', 'confluence');
  const linkedWiki = await f.upload(confluence().bytes, 'integrity-linked-confluence.zip', 'confluence');
  const config = await f.configuration([jira, wiki, linkedWiki]);
  config.excludedRecords = [`${wiki.id}/page:100`];
  const preview = await f.preview(config);
  assert.equal(preview.canApply, true, JSON.stringify(preview.notices));
  assert.equal(preview.counts.explicitExcludedRecords, 1);
  assert.ok(preview.counts.excludedDescendants > 0);
  const applied = await f.apply(preview);
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  const receipt = applied.data.import;
  const reconciliationPath = `/source-imports/${receipt.id}/reconciliation`;
  const manifest = receipt.integrity;
  assert.ok(manifest);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.packages.length, 3);

  async function audit(service = f) {
    const receipts = await service.call<SourceImport[]>('/source-imports');
    assert.equal(receipts.status, 200);
    const current = receipts.data.find(value => value.id === receipt.id);
    assert.ok(current);
    const response = await service.call<SourceReconciliationAudit>(`${reconciliationPath}/audit?expectedVersion=${current.version}`);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.receiptVersion, current.version);
    return response.data;
  }
  function packageIntegrity(report: SourceReconciliationAudit, pkg: LegacyPackageSummary) {
    const inventory = report.integrity.packages.find(value => value.stagingId === pkg.id);
    assert.ok(inventory);
    assert.equal(inventory.filename, pkg.filename);
    return inventory;
  }

  const page = await f.call<SourceReconciliationPage>(`${reconciliationPath}?limit=100`);
  assert.equal(page.status, 200);
  const jiraIssue = page.data.rows.find(value => value.product === 'jira' && value.sourceKey === 'OLD-1');
  const identity = page.data.rows.find(value => value.product === 'jira' && value.kind === 'identity');
  assert.ok(jiraIssue?.target && identity);
  assert.equal(identity.status, 'archive-only');
  const confluenceRows = page.data.rows.filter(value => value.sourceInstance === wiki.source.instanceKey && value.kind !== 'project');
  assert.ok(confluenceRows.some(value => value.kind === 'revision'));
  assert.ok(confluenceRows.some(value => value.kind === 'comment'));
  assert.ok(confluenceRows.some(value => value.kind === 'attachment'));
  assert.equal(confluenceRows.length, preview.counts.excludedRecords);
  assert.ok(confluenceRows.every(value => value.status === 'excluded' && value.target === null));
  const clean = await audit();
  assert.deepEqual(clean.recordCounts, page.data.counts);
  assert.equal(clean.attachmentCounts.excluded, confluenceRows.filter(value => value.kind === 'attachment').length);
  assert.equal(clean.attachmentCounts.verified, 2);
  assert.equal(clean.attachmentCounts.unbound, 0);
  assert.equal(clean.recordCounts.missing, 0);
  assert.equal(clean.integrity.status, 'verified');
  assert.deepEqual(clean.integrity.records, { expected: receipt.counts.sourceRecords, observed: receipt.counts.sourceRecords });
  assert.deepEqual(clean.integrity.boundAttachments, { expected: 2, observed: 2 });
  assert.equal(clean.integrity.unmatchedRecords, 0);
  assert.equal(clean.integrity.columnMismatches, 0);
  for (const pkg of [jira, wiki, linkedWiki]) {
    const expected: SourceImportIntegrityPackage | undefined = manifest.packages.find(value => value.stagingId === pkg.id);
    assert.ok(expected);
    assert.match(expected.recordsSha256, /^[a-f\d]{64}$/);
    const current = packageIntegrity(clean, pkg);
    assert.equal(current.status, 'verified');
    assert.deepEqual(current.recordsSha256, { expected: expected.recordsSha256, observed: expected.recordsSha256 });
    assert.deepEqual(current.records, { expected: expected.recordCount, observed: expected.recordCount });
    assert.deepEqual(current.boundAttachments, { expected: expected.boundAttachmentCount, observed: expected.boundAttachmentCount });
  }

  const trashed = await f.call<{ trashEntryId: string }>(`/issues/${jiraIssue.target.id}`, 'DELETE');
  assert.equal(trashed.status, 200, JSON.stringify(trashed.data));
  assert.equal((await audit()).recordCounts.trashed, clean.recordCounts.trashed + 2, 'The ticket and its migrated comment are both still available in trash.');
  assert.equal((await f.call(`/trash/${trashed.data.trashEntryId}`, 'DELETE')).status, 200);
  const afterPurge = await audit();
  assert.equal(afterPurge.recordCounts.missing, clean.recordCounts.missing + 2);
  assert.equal(afterPurge.recordCounts.excluded, clean.recordCounts.excluded);
  assert.deepEqual(afterPurge.integrity, clean.integrity);

  const backup = await f.call<WorkspaceSnapshot & { schemaVersion: number; sourceImports: SourceImport[]; sourceRecords: SourceRecordArchive[] }>('/export');
  assert.equal(backup.status, 200);
  assert.equal(backup.data.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  const archivedIssueRecord = backup.data.sourceRecords.find(value => value.id === jiraIssue.sourceRecordId);
  assert.ok(archivedIssueRecord?.record.text);
  const updateColumn = f.db.prepare('UPDATE source_records SET source_id=? WHERE id=?');
  assert.equal(updateColumn.run('incorrect-index-value', archivedIssueRecord.id).changes, 1);
  const inconsistentIndex = await audit();
  assert.equal(inconsistentIndex.integrity.status, 'mismatch');
  assert.equal(inconsistentIndex.integrity.columnMismatches, 1);
  assert.deepEqual(packageIntegrity(inconsistentIndex, jira), packageIntegrity(clean, jira));
  assert.equal(updateColumn.run(archivedIssueRecord.record.sourceId, archivedIssueRecord.id).changes, 1);

  const privateMarker = '외부에 내보내지 않는 변형 원문';
  const updateBody = f.db.prepare("UPDATE source_records SET json=json_set(json,'$.record.text',?) WHERE id=?");
  const open = fileSystem.open;
  let changedDuringAudit = false;
  const mutateOnFileRead = t.mock.method(fileSystem, 'open', async (...args: Parameters<typeof open>) => {
    if (!changedDuringAudit) {
      changedDuringAudit = true;
      assert.equal(updateBody.run(privateMarker, archivedIssueRecord.id).changes, 1);
    }
    return open(...args);
  });
  try {
    assert.equal((await f.call(`${reconciliationPath}/audit?expectedVersion=${receipt.version}`)).status, 409);
    assert.equal(changedDuringAudit, true);
  } finally { mutateOnFileRead.mock.restore(); }
  const sameCount = await audit();
  assert.deepEqual(sameCount.recordCounts, afterPurge.recordCounts, 'Changing an archived body has no effect on link and trash classifications.');
  assert.doesNotMatch(JSON.stringify(sameCount), new RegExp(privateMarker));
  assert.equal(sameCount.integrity.status, 'mismatch');
  assert.deepEqual(sameCount.integrity.records, clean.integrity.records);
  assert.deepEqual(sameCount.integrity.boundAttachments, clean.integrity.boundAttachments);
  assert.equal(sameCount.integrity.columnMismatches, 0);
  const jiraIntegrity = packageIntegrity(sameCount, jira);
  assert.equal(jiraIntegrity.status, 'mismatch');
  assert.notEqual(jiraIntegrity.recordsSha256.observed, jiraIntegrity.recordsSha256.expected);
  assert.deepEqual(packageIntegrity(sameCount, wiki), packageIntegrity(clean, wiki));
  assert.deepEqual(packageIntegrity(sameCount, linkedWiki), packageIntegrity(clean, linkedWiki));

  const removeIdentity = "DELETE FROM source_records WHERE import_id=? AND id=? AND kind='identity'";
  assert.equal(f.db.prepare(removeIdentity).run(receipt.id, identity.sourceRecordId).changes, 1);
  const incomplete = await audit();
  assert.equal(incomplete.recordCounts['archive-only'], afterPurge.recordCounts['archive-only'] - 1);
  assert.equal(incomplete.recordCounts.missing, afterPurge.recordCounts.missing, 'Canonical target loss and archival record loss have separate evidence.');
  assert.deepEqual(incomplete.attachmentCounts, afterPurge.attachmentCounts);
  assert.equal(incomplete.integrity.status, 'mismatch');
  assert.deepEqual(incomplete.integrity.records, { expected: receipt.counts.sourceRecords, observed: receipt.counts.sourceRecords - 1 });
  assert.deepEqual(incomplete.integrity.boundAttachments, clean.integrity.boundAttachments);

  const archivedFile = backup.data.sourceRecords.find(value => value.source.instanceKey === linkedWiki.source.instanceKey && value.record.id === 'attachment:701');
  assert.ok(archivedFile?.targetId);
  assert.equal(f.db.prepare('DELETE FROM source_records WHERE import_id=? AND id=?').run(receipt.id, archivedFile.id).changes, 1);
  const missingFileArchive = await audit();
  assert.equal(missingFileArchive.integrity.status, 'mismatch');
  assert.deepEqual(missingFileArchive.integrity.records, { expected: receipt.counts.sourceRecords, observed: receipt.counts.sourceRecords - 2 });
  assert.deepEqual(missingFileArchive.integrity.boundAttachments, { expected: 2, observed: 1 });
  assert.equal(packageIntegrity(missingFileArchive, linkedWiki).status, 'mismatch');
  assert.equal(missingFileArchive.attachmentCounts.missing, 0, 'The archival row is gone even though its attachment bytes still exist.');
  const download = await fetch(`${f.base}/attachment-versions/${archivedFile.targetId}/download`);
  assert.equal(download.status, 200);
  await download.arrayBuffer();

  const badBackups = [
    backup.data.sourceRecords.filter(value => value.id !== identity.sourceRecordId),
    backup.data.sourceRecords.map(value => value.id === archivedIssueRecord.id ? { ...value, record: { ...value.record, text: privateMarker } } : value),
    backup.data.sourceRecords.map(value => value.excluded === true ? { ...value, excluded: undefined } : value),
  ];
  for (const sourceRecords of badBackups) {
    const result = await f.call('/import', 'POST', { data: { ...backup.data, sourceRecords } });
    assert.equal(result.status, 400, JSON.stringify(result.data));
    assert.deepEqual((await audit()).integrity, missingFileArchive.integrity);
  }

  const corruptJson = f.db.prepare('UPDATE source_records SET json=? WHERE id=?');
  assert.equal(corruptJson.run('{', archivedIssueRecord.id).changes, 1);
  const malformedArchive = await audit();
  assert.equal(malformedArchive.integrity.status, 'mismatch');
  assert.equal(malformedArchive.integrity.unmatchedRecords, 1);
  assert.equal(malformedArchive.integrity.columnMismatches, 1);
  assert.deepEqual(malformedArchive.integrity.records, missingFileArchive.integrity.records);

  const reordered = { ...backup.data, sourceRecords: [...backup.data.sourceRecords].reverse() };
  assert.equal((await f.call('/import', 'POST', { data: reordered })).status, 200);
  const restored = await audit();
  assert.equal(restored.receiptVersion, receipt.version + 1);
  assert.deepEqual(restored.recordCounts, afterPurge.recordCounts);
  assert.deepEqual(restored.attachmentCounts, afterPurge.attachmentCounts);
  assert.deepEqual(restored.integrity, clean.integrity);

  const legacy = await fixture();
  t.after(() => legacy.close());
  const oldBackup = structuredClone(backup.data);
  oldBackup.schemaVersion = 32;
  for (const original of oldBackup.sourceImports) delete original.integrity;
  for (const original of oldBackup.sourceRecords) delete original.excluded;
  const loadedOld = await legacy.call('/import', 'POST', { data: oldBackup });
  assert.equal(loadedOld.status, 200, JSON.stringify(loadedOld.data));
  const countsOnly = await audit(legacy);
  assert.equal(countsOnly.integrity.status, 'counts-only');
  assert.deepEqual(countsOnly.integrity.records, clean.integrity.records);
  assert.deepEqual(countsOnly.integrity.boundAttachments, clean.integrity.boundAttachments);
  assert.ok(countsOnly.integrity.packages.every(value => value.status === 'unavailable' && value.recordsSha256.expected === null));
  assert.equal(legacy.db.prepare(removeIdentity).run(receipt.id, identity.sourceRecordId).changes, 1);
  const oldIncomplete = await audit(legacy);
  assert.equal(oldIncomplete.integrity.status, 'mismatch');
  assert.deepEqual(oldIncomplete.integrity.records, incomplete.integrity.records);
  assert.ok(oldIncomplete.integrity.packages.every(value => value.status === 'unavailable'));
  const missingOldBackup = { ...oldBackup, sourceRecords: oldBackup.sourceRecords.filter(value => value.id !== identity.sourceRecordId) };
  assert.equal((await legacy.call('/import', 'POST', { data: missingOldBackup })).status, 200);
  assert.deepEqual((await audit(legacy)).integrity, oldIncomplete.integrity);
});

test('interrupted append recovery removes only uncommitted owned files and retains exact committed versions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'teamspace-migration-recovery-')), append = new AttachmentAppend(dir), file = (text: string): AppendedFile => { const bytes = Buffer.from(text); return { id: randomUUID(), bytes, size: bytes.length, sha256: hash(bytes) }; };
  try {
    const uploads = join(dir, 'uploads'), sentinel = join(uploads, 'operator-note.txt'); writeFileSync(sentinel, 'keep unrelated file');
    const uncommitted = randomUUID(), pending = [file('partially installed'), file('still staged')]; append.stage(uncommitted, pending);
    writeFileSync(join(dir, `.append-${uncommitted}.json`), JSON.stringify({ id: uncommitted, stage: `.append-stage-${uncommitted}`, files: pending.map(value => value.id) }), { mode: 0o600 }); renameSync(join(dir, `.append-stage-${uncommitted}`, pending[0].id), join(uploads, pending[0].id));
    new AttachmentAppend(dir).recover(() => false); for (const value of pending) assert.equal(existsSync(join(uploads, value.id)), false); assert.equal(existsSync(join(dir, `.append-stage-${uncommitted}`)), false);
    const committed = randomUUID(), durable = [file('committed first version'), file('committed latest version')], transaction = append.stage(committed, durable); transaction.install(); assert.equal(existsSync(join(dir, `.append-${committed}.json`)), true);
    new AttachmentAppend(dir).recover(id => id === committed); for (const value of durable) assert.deepEqual(readFileSync(join(uploads, value.id)), value.bytes); assert.equal(readFileSync(sentinel, 'utf8'), 'keep unrelated file'); assert.ok(!readdirSync(dir).some(value => value.startsWith('.append-')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
