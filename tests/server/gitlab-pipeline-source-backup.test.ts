import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../../server/app.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type { DeliveryBlockerDraftResult, DeliveryBlockerReport, GitlabLink, GitlabSettings, Issue, WorkspaceSnapshot } from '../../shared/types.js';

type Backup = WorkspaceSnapshot & { schemaVersion: number; trashEntries: { id: string; gitlabLinks: GitlabLink[] }[] };

test('pipeline execution metadata survives native backup and archived issue restore and is versioned', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'donefac-pipeline-source-backup-'));
  const runtime = createApp({ dataDir, seed: true, outboundWorker: false, deadlineReminderWorker: false });
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    runtime.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const root = `http://127.0.0.1:${address.port}/api`;
  async function call<T>(path: string, method = 'GET', body?: unknown, status = 200, headers: Record<string, string> = {}) {
    const response = await fetch(root + path, {
      method, headers: { 'X-Actor-Id': 'user-seo', ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await response.text();
    assert.equal(response.status, status, raw);
    return JSON.parse(raw) as T;
  }
  const integration = '/integrations/gitlab';
  const baseUrl = 'https://git.example.test';
  const webUrl = `${baseUrl}/team/repo`;
  const secret = 'synthetic-pipeline-backup';
  const { version } = await call<GitlabSettings>(integration);
  await call(integration, 'PATCH', { expectedVersion: version, baseUrl, projectIds: [42], webhookSecret: secret });
  const { projects: [project] } = await call<WorkspaceSnapshot>('/workspace');
  const create = (title: string) => call<Issue>('/issues', 'POST', { projectId: project.id, title }, 201);
  const active = await create('Active pipelines from distinct execution sources');
  const archived = await create('Archived pipeline using a tag');
  const observe = (issue: Issue, id: number, source: string, tag: boolean, status: string) =>
    call<{ linked: number }>(`${integration}/webhook`, 'POST', {
      object_kind: 'pipeline',
      project: { id: 42, web_url: webUrl },
      object_attributes: {
        id, iid: id - 100, ref: `feature/${issue.key}`, sha: 'c'.repeat(40), source, tag, status,
        finished_at: new Date(Date.UTC(2024, 1, 10, 8, 0, id - 100)).toISOString(), url: `${webUrl}/-/pipelines/${id}`,
      },
    }, 200, { 'X-Gitlab-Token': secret, 'X-Gitlab-Event': 'Pipeline Hook', 'X-Gitlab-Event-UUID': randomUUID() });
  assert.equal((await observe(active, 101, 'merge_request_event', false, 'failed')).linked, 1);
  assert.equal((await observe(active, 102, 'push', false, 'success')).linked, 1);
  assert.equal((await observe(archived, 103, 'push', true, 'failed')).linked, 1);
  assert.equal((await observe(active, 104, 'schedule', false, 'manual')).linked, 1);
  const { trashEntryId } = await call<{ trashEntryId: string }>(`/issues/${archived.id}`, 'DELETE');

  const reportPath = `/projects/${project.id}/delivery-blockers`;
  const report = await call<DeliveryBlockerReport>(`${reportPath}?reason=gitlab`);
  const activeCounts = { blockedMergeRequests: 0, failedPipelines: 1, manualPipelines: 1 };
  assert.deepEqual(report.items.find(item => item.issue.id === active.id)?.gitlab, activeCounts);
  const { document: meeting } = await call<DeliveryBlockerDraftResult>(`${reportPath}/meeting-draft`, 'POST', {
    requestId: randomUUID(), revision: report.revision, title: '릴리스 파이프라인 점검', reason: 'gitlab',
  }, 201);
  assert.match(meeting.plainText, /수동 실행 대기 파이프라인 1건/u);

  const data = await call<Backup>('/export');
  assert.equal(data.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  const activeLinks = data.gitlabLinks.filter(link => link.issueId === active.id);
  assert.deepEqual(activeLinks.map(link => [link.pipelineSource, link.pipelineTag]), [['merge_request_event', false], ['push', false], ['schedule', false]]);
  assert.ok(activeLinks.every(link => link.pipelineTicketEvidence === 'direct-key'));
  const entry = data.trashEntries.find(item => item.id === trashEntryId);
  assert.ok(entry);
  const [archivedLink] = entry.gitlabLinks;
  assert.deepEqual([archivedLink.pipelineSource, archivedLink.pipelineTag], ['push', true]);
  assert.equal(archivedLink.pipelineTicketEvidence, 'direct-key');

  const invalidActive = [
    { ...activeLinks[0], pipelineSource: 'invalid source' },
    { ...activeLinks[0], pipelineTag: 'false' },
    { ...activeLinks[0], kind: 'merge_request' },
    { ...activeLinks[0], id: activeLinks[0].id.replace(':42:', ':43:') },
    { ...activeLinks[0], id: activeLinks[0].id.replace(':101:', ':9007199254740992:') },
    { ...activeLinks[0], pipelineTicketEvidence: 'unknown' },
    { ...activeLinks[0], manualLinkId: randomUUID() },
    { ...activeLinks[0], pipelineObservedAt: null },
    { ...activeLinks[0], sourceSha: 'c'.repeat(7) },
    { ...activeLinks[0], webUrl: `${webUrl}/-/pipelines/999` },
  ];
  for (const invalid of invalidActive) {
    const result = await call<{ error: string }>('/import', 'POST', {
      data: { ...data, gitlabLinks: [invalid, ...activeLinks.slice(1)] },
    }, 400);
    assert.match(result.error, /GitLab 연결/);
  }
  const invalidArchive = structuredClone(data);
  invalidArchive.trashEntries.find(item => item.id === trashEntryId)!.gitlabLinks[0].pipelineSource = 'x'.repeat(65);
  await call('/import', 'POST', { data: invalidArchive }, 400);
  const legacyWithFields = await call<{ error: string }>('/import', 'POST', { data: { ...data, schemaVersion: 100 } }, 400);
  assert.match(legacyWithFields.error, /schemaVersion 101/);
  const priorFormat = await call<{ error: string }>('/import', 'POST', { data: { ...data, schemaVersion: 121 } }, 400);
  assert.match(priorFormat.error, /schemaVersion 122/);
  assert.deepEqual((await call<Backup>('/export')).gitlabLinks, data.gitlabLinks);

  await call('/import', 'POST', { data });
  const restoredReport = await call<DeliveryBlockerReport>(`${reportPath}?reason=gitlab`);
  assert.deepEqual(restoredReport.items.find(item => item.issue.id === active.id)?.gitlab, activeCounts);
  await call(`/trash/${trashEntryId}/restore`, 'POST');
  const restored = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(restored.gitlabLinks.filter(link => link.issueId === active.id), activeLinks);
  assert.deepEqual(restored.gitlabLinks.find(link => link.issueId === archived.id), archivedLink);
  assert.deepEqual(restored.documents.find(document => document.id === meeting.id)?.content, meeting.content);

  const legacy = structuredClone(data);
  legacy.schemaVersion = 100;
  for (const link of [...legacy.gitlabLinks, ...legacy.trashEntries.flatMap(item => item.gitlabLinks)]) {
    delete link.pipelineSource;
    delete link.pipelineTag;
    delete link.pipelineTicketEvidence;
  }
  await call('/import', 'POST', { data: legacy });
  const exportedLegacy = await call<Backup>('/export');
  assert.equal(exportedLegacy.gitlabLinks.filter(link => link.issueId === active.id).length, 3);
  assert.ok([...exportedLegacy.gitlabLinks, ...exportedLegacy.trashEntries.flatMap(item => item.gitlabLinks)]
    .every(link => !Object.hasOwn(link, 'pipelineSource') && !Object.hasOwn(link, 'pipelineTag') && !Object.hasOwn(link, 'pipelineTicketEvidence')));
  const legacyReport = await call<DeliveryBlockerReport>(`${reportPath}?reason=gitlab`);
  assert.deepEqual(legacyReport.items.find(item => item.issue.id === active.id)?.gitlab,
    { blockedMergeRequests: 0, failedPipelines: 0, manualPipelines: 1 });
});
