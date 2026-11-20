import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import express from 'express';
import { createApp } from '../../server/app.js';
import { createPilotAccess, type PilotAccess } from '../../server/pilot-access.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import { contentReferences, documentPlainText } from '../../shared/document-nodes.js';
import type { Issue, Project, ProjectReport, ReportingLedgerData, ReportQuery, ReportSnapshot, ReportSnapshotSummary, ReportStatusDuration, DocRevision, WorkspaceSnapshot } from '../../shared/types.js';

type Backup = WorkspaceSnapshot & { schemaVersion: number; exportedAt: string; reportingLedger: ReportingLedgerData; reportSnapshots: ReportSnapshot[]; revisions: DocRevision[] };
async function fixture(teamAccess = false) {
  const dir = mkdtempSync(join(tmpdir(), 'teamspace-reporting-integration-'));
  const service = createApp({ dataDir: dir, outboundWorker: false });
  let access: PilotAccess | null = null;
  const web = express();
  web.use((request, response, next) => access ? access.middleware(request, response, next) : next());
  web.use(service.app);
  const server = web.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const base = `http://${address}/api`, origin = `https://${address}`;
  async function close() {
    await new Promise<void>(resolve => server.close(() => resolve()));
    access?.close();
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
  let cookie = '';
  if (teamAccess) {
    try {
      const accessCode = 'a'.repeat(64), accessFile = join(dir, 'access.code');
      writeFileSync(accessFile, accessCode, { mode: 0o600 });
      access = createPilotAccess({ NODE_ENV: 'test', TEAMSPACE_PILOT_ORIGIN: origin, TEAMSPACE_PILOT_ACCESS_FILE: accessFile });
      const login = await fetch(`http://${address}/pilot-access`, {
        method: 'POST', headers: { Origin: origin }, redirect: 'manual', body: new URLSearchParams({ accessCode }),
      });
      cookie = login.headers.getSetCookie()[0]?.split(';')[0] ?? '';
      assert.equal(login.status, 303);
      assert.ok(cookie);
    } catch (error) {
      await close();
      throw error;
    }
  }
  return {
    dir,
    async call<T = Record<string, unknown>>(path: string, method = 'GET', body?: unknown, actorId = 'user-yun', signedIn = true) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Actor-Id': actorId };
      if (teamAccess) headers.Origin = origin;
      if (cookie && signedIn) headers.Cookie = cookie;
      const response = await fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, data: await response.json() as T };
    },
    close,
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
    assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION); assert.ok(backup.reportingLedger.coverage.every(value => value.endedAt !== null));
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

test('format 55 validates and restores state dwell while signed-in teams retain access to earlier report snapshots', async () => {
  const f = await fixture(true);
  try {
    const p = await project(f), today = Date.now(), day = 86_400_000;
    const q = { ...query(p.id), assigneeId: 'user-seo', startDate: new Date(today - day).toISOString().slice(0, 10),
      endDate: new Date(today + day).toISOString().slice(0, 10) };
    let ticket = await createIssue(f, p.id, '검토를 기다리는 합성 업무');
    ticket = await change(f, ticket, { status: 'in_progress', assigneeId: 'user-seo' });
    ticket = await change(f, ticket, { status: 'review' });
    const other = await createIssue(f, p.id, '범위 밖 담당자의 합성 업무');
    await change(f, other, { status: 'in_progress', assigneeId: 'user-yun' });
    const outside = await createIssue(f, 'project-team', '다른 프로젝트 합성 업무');
    await change(f, outside, { assigneeId: 'user-seo' });

    const snapshot = await capture(f, q);
    assert.equal(snapshot.report.definitionVersion, 2);
    const dwell = snapshot.report.statusDuration;
    assert.ok(dwell);
    assert.deepEqual(dwell.openIssues.map(row => row.issueId), [ticket.id]);
    assert.equal(dwell.openIssues[0].statusId, 'review');
    assert.ok(dwell.openIssues[0].elapsedHours !== null);
    assert.ok(dwell.completedVisits.some(row => row.statusId === 'in_progress' && row.samples === 1));
    const path = `/projects/${p.id}/report-snapshots/${snapshot.id}`;
    const workspace = (await f.call<WorkspaceSnapshot>('/workspace')).data;
    const document = workspace.documents.find(value => value.id === snapshot.documentId);
    assert.ok(document);
    assert.match(document.plainText, /상태별 체류 시간/u);
    assert.match(document.plainText, /미완료 업무 1개 중 현재 상태 진입 관측 1개/u);
    assert.deepEqual(contentReferences(document.content).map(reference => reference.id), [ticket.id]);
    assert.equal(workspace.resourceLinks.filter(link => link.issueId === ticket.id && link.documentId === document.id).length, 1);
    const blocks = document.content.content ?? [];
    const ticketLink = blocks.findIndex(block => block.type === 'issueReference' && block.attrs?.issueId === ticket.id);
    const capturedAge = blocks[ticketLink - 1];
    assert.equal(capturedAge?.type, 'paragraph');
    assert.match(documentPlainText(capturedAge), new RegExp(`^${ticket.key} · ${dwell.openIssues[0].statusLabel} · (1분 미만|[\\d,.]+(?:분|시간)) 체류$`, 'u'));

    const { data: backup } = await f.call<Backup>('/export');
    assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
    await change(f, ticket, { title: '보고를 작성한 뒤 변경한 제목', status: 'todo' });
    assert.equal((await report(f, q)).statusDuration?.openIssues[0].statusId, 'todo');
    assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).data.documents.find(value => value.id === document.id), document);
    const downgraded = await f.call<{ error: string }>('/import', 'POST', { data: { ...backup, schemaVersion: 54 } });
    assert.equal(downgraded.status, 400);
    assert.match(downgraded.data.error, /schemaVersion 55/u);
    const missing = structuredClone(backup);
    delete missing.reportSnapshots[0].report.statusDuration;
    assert.equal((await f.call('/import', 'POST', { data: missing })).status, 400);
    const corruptions: ((value: ReportStatusDuration) => void)[] = [
      value => { const row = value.openIssues[0]; row.elapsedHours = (row.elapsedHours ?? 0) + 1; },
      value => { value.openIssues[0].category = 'done'; },
      value => { value.openIssues[0].issueId = outside.id; },
      value => { value.completedVisits.push({ ...value.completedVisits[0] }); },
      value => { value.completedVisits[0].samples = 0; },
    ];
    for (const corrupt of corruptions) {
      const damaged = structuredClone(backup);
      const value = damaged.reportSnapshots[0].report.statusDuration;
      assert.ok(value);
      corrupt(value);
      const rejected = await f.call('/import', 'POST', { data: damaged });
      assert.equal(rejected.status, 400);
    }
    assert.deepEqual((await f.call<ReportSnapshot>(path)).data, snapshot);
    const restored = await f.call('/import', 'POST', { data: backup });
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    assert.deepEqual((await f.call<ReportSnapshot>(path)).data, snapshot);

    const earlier = structuredClone(backup), legacy = earlier.reportSnapshots[0];
    earlier.schemaVersion = 54;
    legacy.report.definitionVersion = 1;
    delete legacy.report.statusDuration;
    const older = await f.call('/import', 'POST', { data: earlier });
    assert.equal(older.status, 200, JSON.stringify(older.data));
    assert.equal((await f.call(path, 'GET', undefined, 'user-yun', false)).status, 401);
    assert.deepEqual((await f.call<ReportSnapshot>(path)).data, legacy);
    assert.equal((await f.call(`/projects/project-team/report-snapshots/${snapshot.id}`)).status, 404);
    const afterRestore = await report(f, q);
    assert.equal(afterRestore.definitionVersion, 2);
    assert.deepEqual(afterRestore.statusDuration?.openIssues, [{ ...dwell.openIssues[0], enteredAt: null, elapsedHours: null }]);
  } finally { await f.close(); }
});
