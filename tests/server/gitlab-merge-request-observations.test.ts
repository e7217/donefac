import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../../server/app.js';
import type { GitlabMergeRequestReadObservation } from '../../server/gitlab-merge-request-observations.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type { GitlabIssueRefreshResult, GitlabLink, GitlabSettings, Issue } from '../../shared/types.js';

const repositoryId = 42;
const objectId = 720;
const iid = 17;
const first = '2026-07-10T10:00:00.000Z';
const second = '2026-07-10T11:00:00.000Z';
const third = '2026-07-10T12:00:00.000Z';
const apiProject = `/forge/api/v4/projects/${repositoryId}`;

type NativeBackup = { schemaVersion: number; exportedAt: string; gitlabMergeRequestObservations?: GitlabMergeRequestReadObservation[] };

test('scoped MR reads establish a monotone baseline that survives restart and validated native restore', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'donefac-gitlab-mr-observation-'));
  let baseUrl = '';
  const repoUrl = () => `${baseUrl}/team/product`;
  const mergeRequestUrl = (number = iid) => `${repoUrl()}/-/merge_requests/${number}`;
  let detail: Record<string, unknown> = {};
  let list: Record<string, unknown>[] = [];
  const gitlab = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? '/', 'http://fixture.test');
    let body: unknown;
    if (pathname === apiProject) body = { id: repositoryId, path_with_namespace: 'team/product', web_url: repoUrl() };
    else if (pathname === `${apiProject}/merge_requests/${iid}`) body = detail;
    else if (pathname === `${apiProject}/merge_requests`) body = list;
    else if (pathname === `${apiProject}/pipelines`) body = [];
    else { response.statusCode = 404; body = {}; }
    response.setHeader('Content-Type', 'application/json').end(JSON.stringify(body));
  });
  gitlab.listen(0, '127.0.0.1');
  await once(gitlab, 'listening');
  baseUrl = `http://127.0.0.1:${(gitlab.address() as AddressInfo).port}/forge`;
  async function stop(server: ReturnType<typeof createServer>) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  async function startWorkspace() {
    const runtime = createApp({ dataDir, seed: true, outboundWorker: false, deadlineReminderWorker: false, recurringIssueWorker: false });
    const server = runtime.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    return { url, async close() { try { await stop(server); } finally { runtime.close(); } } };
  }
  let workspace = await startWorkspace();
  t.after(async () => {
    try { await Promise.all([workspace.close(), stop(gitlab)]); }
    finally { rmSync(dataDir, { recursive: true, force: true }); }
  });
  async function call<T = unknown>(path: string, method = 'GET', body?: unknown, status = 200): Promise<T> {
    const response = await fetch(workspace.url + path, { method, headers: { 'X-Actor-Id': 'user-seo', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const raw = await response.text();
    assert.equal(response.status, status, raw);
    return JSON.parse(raw) as T;
  }
  const exportBackup = () => call<NativeBackup>('/export');
  const { version } = await call<GitlabSettings>('/integrations/gitlab');
  const settings = await call<GitlabSettings>('/integrations/gitlab', 'PATCH', { expectedVersion: version, baseUrl, projectIds: [repositoryId],
    token: 'fixture-read-key' });
  const issue = await call<Issue>('/issues', 'POST', { projectId: 'project-neo', title: 'MR read provenance' }, 201);
  const mr = { id: objectId, iid, project_id: repositoryId, target_project_id: repositoryId, title: `${issue.key} Review`,
    source_branch: 'feature/review', sha: 'a'.repeat(40), state: 'opened', updated_at: first, web_url: mergeRequestUrl() };
  detail = mr;
  const row = (id: number, number: number, patch: Record<string, unknown>) => ({ ...mr, id, iid: number, title: 'Unlinked MR',
    web_url: mergeRequestUrl(number), ...patch });
  const standalone = row(721, 18, {});
  list = [mr, standalone, row(722, 19, { project_id: 99 }), row(723, 20, { target_project_id: 99 }),
    row(724, 21, { updated_at: undefined, created_at: first }), row(725, 22, { project_id: undefined }),
    row(726, 23, { web_url: mergeRequestUrl(99) }), row(727, 24, { state: 'locked' }),
    row(728, 25, { updated_at: '2026-07-99T11:00:00.000Z' }), row(729, 26, { updated_at: '9999-01-01T00:00:00.000Z' })];
  await call('/integrations/gitlab/sync-preview', 'POST', { expectedVersion: settings.version });
  assert.deepEqual((await exportBackup()).gitlabMergeRequestObservations, []);

  const issueLinks = `/issues/${encodeURIComponent(issue.id)}/gitlab-links`;
  const link = await call<GitlabLink>(issueLinks, 'POST', { url: mergeRequestUrl(), repositoryId, expectedSettingsVersion: settings.version }, 201);
  const instance = createHash('sha256').update(baseUrl).digest('hex').slice(0, 12);
  const observation = { instance, repositoryId, objectId, iid, state: 'opened', updatedAt: first, source: 'read' } as const;
  assert.deepEqual((await exportBackup()).gitlabMergeRequestObservations, [observation]);
  const exact = () => call<GitlabIssueRefreshResult>(`${issueLinks}/${encodeURIComponent(link.id)}/refresh`, 'POST');
  detail = { ...mr, state: 'closed', updated_at: second };
  assert.equal((await exact()).links[0]?.state, 'closed');
  const closed = { ...observation, state: 'closed', updatedAt: second };
  assert.deepEqual((await exportBackup()).gitlabMergeRequestObservations, [closed]);

  await call('/integrations/gitlab/sync', 'POST', {});
  const standaloneEvidence = { ...observation, objectId: standalone.id, iid: standalone.iid };
  assert.deepEqual((await exportBackup()).gitlabMergeRequestObservations, [closed, standaloneEvidence]);
  assert.equal((await call<{ links: GitlabLink[] }>(issueLinks)).links.find(item => item.id === link.id)?.state, 'closed');

  detail = { ...mr, updated_at: second };
  const conflicted = await exact();
  assert.deepEqual(conflicted.links, []);
  assert.deepEqual(conflicted.failures.map(failure => failure.linkId), [link.id]);
  const saved = await exportBackup();
  const conflict = { ...closed, state: null };
  assert.equal(saved.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.deepEqual(saved.gitlabMergeRequestObservations, [conflict, standaloneEvidence]);

  await workspace.close();
  workspace = await startWorkspace();
  assert.deepEqual((await exportBackup()).gitlabMergeRequestObservations, saved.gitlabMergeRequestObservations);
  await call('/import', 'POST', { data: { ...saved, schemaVersion: 116 } }, 400);
  for (const invalid of [{ ...conflict, source: 'webhook' }, { ...conflict, state: 'locked' }, { ...conflict, iid: String(iid) },
    { ...conflict, instance: 'incorrect' }, { ...conflict, updatedAt: '9999-01-01T00:00:00.000Z' },
    { ...conflict, updatedAt: '2026-07-91T11:00:00.000Z' }, { ...conflict, extra: true }, standaloneEvidence]) {
    await call('/import', 'POST', { data: { ...saved, gitlabMergeRequestObservations: [invalid, standaloneEvidence] } }, 400);
  }
  assert.deepEqual((await exportBackup()).gitlabMergeRequestObservations, saved.gitlabMergeRequestObservations);

  const legacy = { ...saved, schemaVersion: 116 };
  delete legacy.gitlabMergeRequestObservations;
  await call('/import', 'POST', { data: legacy });
  assert.deepEqual((await exportBackup()).gitlabMergeRequestObservations, []);
  await call('/import', 'POST', { data: saved });
  assert.deepEqual((await exportBackup()).gitlabMergeRequestObservations, saved.gitlabMergeRequestObservations);
  detail = { ...mr, state: 'merged', updated_at: third };
  assert.equal((await exact()).links[0]?.state, 'merged');
  assert.deepEqual((await exportBackup()).gitlabMergeRequestObservations, [
    { ...observation, state: 'merged', updatedAt: third }, standaloneEvidence,
  ]);
});
