import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createApp } from '../../server/app.js';
import { contentReferences, documentPlainText } from '../../shared/document-nodes.js';
import type { Issue, Project, ProjectReport, ReportingLedgerData, ReportQuery, ReportSnapshot, ReportSnapshotSummary, DocRevision, WorkspaceSnapshot } from '../../shared/types.js';

type Backup = WorkspaceSnapshot & { schemaVersion: number; exportedAt: string; reportingLedger: ReportingLedgerData; reportSnapshots: ReportSnapshot[]; revisions: DocRevision[] };
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'teamspace-reporting-integration-'));
  const service = createApp({ dataDir: dir, outboundWorker: false }), server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  return {
    dir,
    async call<T = Record<string, unknown>>(path: string, method = 'GET', body?: unknown, actorId = 'user-yun') {
      const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actorId }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, data: await response.json() as T };
    },
    async close() { await new Promise<void>(resolve => server.close(() => resolve())); service.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function query(projectId: string): ReportQuery {
  const today = new Date().toISOString().slice(0, 10);
  return { projectId, startDate: today, endDate: today, timeZone: 'UTC', issueType: null, assigneeId: null };
}
async function report(f: Fixture, reportQuery: ReportQuery) {
  const params = new URLSearchParams({ startDate: reportQuery.startDate, endDate: reportQuery.endDate, timeZone: reportQuery.timeZone });
  if (reportQuery.issueType !== null) params.set('issueType', reportQuery.issueType);
  if (reportQuery.assigneeId !== null) params.set('assigneeId', reportQuery.assigneeId);
  const response = await f.call<ProjectReport>(`/projects/${reportQuery.projectId}/report?${params}`);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data;
}
async function project(f: Fixture) {
  const made = await f.call<Project>('/projects', 'POST', { key: 'RPT', name: '합성 주간 보고 프로젝트' });
  assert.equal(made.status, 201, JSON.stringify(made.data)); return made.data;
}
async function createIssue(f: Fixture, projectId: string, title = '합성 보고 검증 업무') {
  const made = await f.call<Issue>('/issues', 'POST', { projectId, title });
  assert.equal(made.status, 201, JSON.stringify(made.data)); return made.data;
}
async function change(f: Fixture, issue: Issue, fields: Partial<Issue>) {
  const response = await f.call<Issue>(`/issues/${issue.id}`, 'PATCH', { expectedVersion: issue.version, ...fields });
  assert.equal(response.status, 200, JSON.stringify(response.data)); return response.data;
}
async function capture(f: Fixture, reportQuery: ReportQuery, title = '합성 주간 보고 확정본') {
  const response = await f.call<ReportSnapshot>(`/projects/${reportQuery.projectId}/report-snapshots`, 'POST', { query: reportQuery, title }, 'user-seo');
  assert.equal(response.status, 201, JSON.stringify(response.data)); return response.data;
}

test('HTTP reports separate observation baselines from real completions, repeated completions and reopening transitions', async () => {
  const f = await fixture();
  try {
    const initial = (await f.call<WorkspaceSnapshot>('/workspace')).data;
    const before = await report(f, query('project-neo'));
    const workflow = initial.workflows!.find(value => value.projectId === 'project-neo')!;
    const seededDone = initial.issues.filter(issue => issue.projectId === 'project-neo' && workflow.statuses.find(status => status.id === issue.status)?.category === 'done').length;
    assert.ok(seededDone > 0); assert.equal(before.current.state.done, seededDone);
    assert.equal(before.period.created, 0); assert.equal(before.period.completionTransitions, 0); assert.equal(before.period.completedIssues, 0); assert.equal(before.period.reopened, 0);
    const p = await project(f), q = query(p.id);
    let issue = await createIssue(f, p.id);
    issue = await change(f, issue, { status: 'in_progress' });
    issue = await change(f, issue, { status: 'done' });
    issue = await change(f, issue, { status: 'todo' });
    issue = await change(f, issue, { status: 'done' });
    const current = await report(f, q);
    assert.equal(current.current.total, 1); assert.equal(current.current.state.done, 1);
    assert.equal(current.period.created, 1); assert.equal(current.period.completedIssues, 1); assert.equal(current.period.completionTransitions, 2); assert.equal(current.period.repeatedCompletions, 1); assert.equal(current.period.reopened, 1);
    assert.equal(current.issues.find(value => value.issue.issueId === issue.id)?.completed, 2);
    assert.equal(current.issues.find(value => value.issue.issueId === issue.id)?.reopened, 1);
    const stale = await f.call(`/issues/${issue.id}`, 'PATCH', { expectedVersion: 1, status: 'review' });
    assert.equal(stale.status, 409); assert.deepEqual((await report(f, q)).period, current.period);
    await f.call(`/issues/${issue.id}`, 'DELETE', { expectedVersion: issue.version });
    const deleted = await report(f, q);
    assert.equal(deleted.current.total, 0); assert.equal(deleted.period.deleted, 1); assert.equal(deleted.period.completionTransitions, 2);
    assert.equal(deleted.issues.find(value => value.issue.issueId === issue.id)?.deleted, true);
    assert.equal((await report(f, query('project-neo'))).period.completionTransitions, 0);
  } finally { await f.close(); }
});

test('report snapshot stores canonical query and metrics with a real document and remains unchanged after later issue edits', async () => {
  const f = await fixture();
  try {
    const p = await project(f), q = query(p.id);
    let issue = await createIssue(f, p.id, '저장 당시 합성 업무 제목');
    issue = await change(f, issue, { status: 'in_progress' }); issue = await change(f, issue, { status: 'done' });
    const snapshot = await capture(f, q, '검토한 합성 주간 보고');
    assert.equal(snapshot.projectId, p.id); assert.equal(snapshot.actorId, 'user-seo'); assert.equal(snapshot.title, '검토한 합성 주간 보고');
    assert.deepEqual(snapshot.report.query, q); assert.equal(snapshot.report.period.completedIssues, 1); assert.equal(snapshot.report.current.state.done, 1);
    const stored = await f.call<ReportSnapshot>(`/projects/${p.id}/report-snapshots/${snapshot.id}`); assert.equal(stored.status, 200); assert.deepEqual(stored.data, snapshot);
    const listed = await f.call<ReportSnapshotSummary[]>(`/projects/${p.id}/report-snapshots`); assert.equal(listed.status, 200);
    const { report: savedReport, ...metadata } = snapshot; assert.deepEqual(listed.data, [{ ...metadata, query: savedReport.query }]);
    const workspace = (await f.call<WorkspaceSnapshot>('/workspace')).data, document = workspace.documents.find(value => value.id === snapshot.documentId);
    assert.ok(document); assert.equal(document.projectId, p.id); assert.equal(document.title, snapshot.title); assert.equal(document.content.type, 'doc');
    assert.equal(document.plainText, documentPlainText(document.content)); assert.ok(document.plainText.trim().length > 0);
    assert.ok(contentReferences(document.content).some(reference => reference.type === 'issue' && reference.id === issue.id));
    assert.ok(workspace.resourceLinks.some(link => link.issueId === issue.id && link.documentId === document.id));
    assert.ok((await f.call<unknown[]>(`/documents/${document.id}/revisions`)).data.length >= 1);
    await change(f, issue, { title: '보고 확정 후 변경한 제목', status: 'todo' });
    assert.equal((await report(f, q)).current.state.done, 0);
    assert.deepEqual((await f.call<ReportSnapshot>(`/projects/${p.id}/report-snapshots/${snapshot.id}`)).data, snapshot);
    const laterDocument = (await f.call<WorkspaceSnapshot>('/workspace')).data.documents.find(value => value.id === document.id);
    assert.deepEqual(laterDocument, document);
    assert.equal((await f.call(`/projects/project-team/report-snapshots/${snapshot.id}`)).status, 404);
    const beforeFailure = (await f.call<Backup>('/export')).data;
    const db = new DatabaseSync(join(f.dir, 'teamspace.sqlite'));
    try {
      db.exec("CREATE TRIGGER reject_report_snapshot BEFORE INSERT ON report_snapshots BEGIN SELECT RAISE(ABORT, 'synthetic snapshot storage failure'); END");
      const rejected = await f.call(`/projects/${p.id}/report-snapshots`, 'POST', { query: q, title: '저장에 실패한 초안' });
      assert.ok(rejected.status >= 400);
      const afterFailure = (await f.call<Backup>('/export')).data;
      for (const key of ['documents', 'resourceLinks', 'activities', 'reportSnapshots', 'revisions'] as const) {
        assert.deepEqual(afterFailure[key], beforeFailure[key]);
      }
    } finally { db.close(); }
  } finally { await f.close(); }
});

test('schema10 restores immutable snapshots and closed historical coverage with new baselines, rejecting inconsistent history atomically', async () => {
  const f = await fixture();
  try {
    const p = await project(f), q = query(p.id);
    let issue = await createIssue(f, p.id, '백업할 합성 업무'); issue = await change(f, issue, { status: 'done' });
    const snapshot = await capture(f, q), backupResponse = await f.call<Backup>('/export'); assert.equal(backupResponse.status, 200);
    const backup = backupResponse.data;
    assert.equal(backup.schemaVersion, 14); assert.ok(backup.reportingLedger.coverage.every(value => value.endedAt !== null));
    assert.deepEqual(backup.reportSnapshots.find(value => value.id === snapshot.id), snapshot);
    const historicalEvents = structuredClone(backup.reportingLedger.events);
    issue = await change(f, issue, { title: '백업 후 변경', status: 'in_progress' });
    const restored = await f.call('/import', 'POST', { data: backup }); assert.equal(restored.status, 200, JSON.stringify(restored.data));
    const workspace = (await f.call<WorkspaceSnapshot>('/workspace')).data;
    assert.equal(workspace.issues.find(value => value.id === issue.id)?.title, '백업할 합성 업무');
    assert.equal(workspace.documents.find(value => value.id === snapshot.documentId)?.title, snapshot.title);
    assert.deepEqual((await f.call<ReportSnapshot>(`/projects/${p.id}/report-snapshots/${snapshot.id}`)).data, snapshot);
    const afterReport = await report(f, q); assert.equal(afterReport.period.completionTransitions, 1); assert.equal(afterReport.period.reopened, 0); assert.equal(afterReport.current.state.done, 1);
    const afterBackup = (await f.call<Backup>('/export')).data;
    assert.equal(afterBackup.reportingLedger.coverage.length, backup.reportingLedger.coverage.length + 1);
    assert.deepEqual(afterBackup.reportingLedger.coverage.slice(0, backup.reportingLedger.coverage.length), backup.reportingLedger.coverage);
    assert.equal(afterBackup.reportingLedger.coverage.at(-1)?.reason, 'restore');
    assert.deepEqual(afterBackup.reportingLedger.events.slice(0, historicalEvents.length), historicalEvents);
    assert.ok(afterBackup.reportingLedger.events.slice(historicalEvents.length).every(event => event.kind === 'baseline' && event.origin === 'import'));
    const corrupted = structuredClone(afterBackup); corrupted.reportingLedger.events[0].sequence = 0;
    const rejected = await f.call('/import', 'POST', { data: corrupted }); assert.equal(rejected.status, 400, JSON.stringify(rejected.data));
    assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).data, workspace);
    assert.deepEqual((await f.call<ReportSnapshot>(`/projects/${p.id}/report-snapshots/${snapshot.id}`)).data, snapshot);
    assert.deepEqual((await f.call<Backup>('/export')).data.reportingLedger.events, afterBackup.reportingLedger.events);
    assert.deepEqual((await report(f, q)).period, afterReport.period);
  } finally { await f.close(); }
});
