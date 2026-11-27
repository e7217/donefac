import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
import type { ApiKeyCreated, DocPage, DocRevision, Issue, Project, ProjectReport, ReportingLedgerData, ReportQuery, ReportSnapshot, ReportSnapshotSummary, ReportStatusDuration, WorkspaceSnapshot } from '../../shared/types.js';

type Backup = WorkspaceSnapshot & { schemaVersion: number; exportedAt: string; reportingLedger: ReportingLedgerData; reportSnapshots: ReportSnapshot[]; revisions: DocRevision[] };
async function fixture(teamAccess = false) {
  const dir = mkdtempSync(join(tmpdir(), 'donefac-reporting-integration-'));
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
      access = createPilotAccess({ NODE_ENV: 'test', DONEFAC_PILOT_ORIGIN: origin, DONEFAC_PILOT_ACCESS_FILE: accessFile });
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
  async function call<T = Record<string, unknown>>(path: string, method = 'GET', body?: unknown, actorId = 'user-yun', signedIn = true, token?: string) {
    const headers: Record<string, string> = { 'X-Actor-Id': actorId };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (teamAccess && signedIn) headers.Origin = origin;
    if (cookie && signedIn) headers.Cookie = cookie;
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as T };
  }
  return {
    dir, call, close,
    publicCall<T = Record<string, unknown>>(path: string, token?: string, method = 'GET', body?: unknown) {
      return call<T>(`/v1${path}`, method, body, 'user-yun', false, token);
    },
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
async function reportKey(f: Fixture, projectIds: string[], access: 'read' | 'write', owner = 'user-seo') {
  const response = await f.call<ApiKeyCreated>('/api-keys', 'POST', { name: '합성 주간 보고 키', projectIds, access, expiresAt: null }, owner);
  assert.equal(response.status, 201, JSON.stringify(response.data));
  return response.data.token;
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
    const db = new DatabaseSync(join(f.dir, 'donefac.sqlite'));
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

test('public report reads enforce project scope and strictly validate query parameters', async () => {
  const f = await fixture(true);
  try {
    const p = await project(f), q = query(p.id);
    await createIssue(f, p.id, '선택한 프로젝트 업무');
    await createIssue(f, 'project-team', '다른 프로젝트 업무');
    const snapshot = await capture(f, q);
    const outsideSnapshot = await capture(f, query('project-team'));
    const reader = await reportKey(f, [p.id], 'read');
    const browserPath = `/projects/${p.id}`;
    const params = new URLSearchParams({ startDate: q.startDate, endDate: q.endDate, timeZone: q.timeZone });
    const live = `${browserPath}/report?${params}`;
    const list = `${browserPath}/report-snapshots`;
    const detail = `${list}/${snapshot.id}`;
    for (const path of [live, list, detail]) {
      assert.equal((await f.publicCall(path)).status, 401);
      assert.equal((await f.publicCall(path.replace(p.id, 'project-team'), reader)).status, 403);
    }

    const liveResponse = await f.publicCall<ProjectReport>(live, reader);
    assert.equal(liveResponse.status, 200, JSON.stringify(liveResponse.data));
    assert.deepEqual(liveResponse.data.query, q);
    assert.deepEqual(liveResponse.data.issues.map(row => row.issue.title), ['선택한 프로젝트 업무']);
    const listResponse = await f.publicCall<ReportSnapshotSummary[]>(list, reader);
    const { report: savedReport, ...metadata } = snapshot;
    assert.equal(listResponse.status, 200);
    assert.deepEqual(listResponse.data, [{ ...metadata, query: savedReport.query }]);
    const detailResponse = await f.publicCall<ReportSnapshot>(detail, reader);
    assert.equal(detailResponse.status, 200);
    assert.deepEqual(detailResponse.data, snapshot);
    assert.equal((await f.publicCall(`${list}/${outsideSnapshot.id}`, reader)).status, 404);

    for (const invalid of [`${live}&startDate=${q.startDate}`, `${live}&projectId=${p.id}`, `${live}&issueType[]=task`, `${list}?limit=1`, `${detail}?timeZone=UTC`]) {
      assert.equal((await f.publicCall(invalid, reader)).status, 400);
    }
  } finally { await f.close(); }
});

test('public weekly capture uses the writer identity and replays the same frozen snapshot exactly once', async () => {
  const f = await fixture(true);
  try {
    const p = await project(f), q = query(p.id);
    const list = `/projects/${p.id}/report-snapshots`;
    let issue = await createIssue(f, p.id, '보고 시점에 완료한 합성 업무');
    issue = await change(f, issue, { status: 'done' });
    const reader = await reportKey(f, [p.id], 'read');
    const writer = await reportKey(f, [p.id], 'write');
    const otherWriter = await reportKey(f, [p.id], 'write', 'user-yun');
    const input = { requestId: randomUUID(), title: '키로 작성한 주간 문서', query: q, actorId: 'user-yun' };
    assert.equal((await f.publicCall(list, undefined, 'POST', input)).status, 401);
    assert.equal((await f.publicCall(list, reader, 'POST', input)).status, 403);
    assert.equal((await f.publicCall(list.replace(p.id, 'project-team'), writer, 'POST', input)).status, 403);
    const noBody = await f.publicCall<{ details: { reason: string } }>(list, writer, 'POST');
    assert.equal(noBody.status, 400);
    assert.equal(noBody.data.details.reason, 'invalid_request_id');
    assert.equal((await f.publicCall(list, writer, 'POST', { title: input.title, query: q })).status, 400);
    assert.equal((await f.publicCall(list, writer, 'POST', { ...input, requestId: '00000000-0000-1000-8000-000000000000' })).status, 400);
    assert.equal((await f.publicCall(list, writer, 'POST', { ...input, query: { ...q, projectId: 'project-team' } })).status, 400);
    assert.equal((await f.publicCall(list, writer, 'POST', { ...input, projectId: p.id })).status, 400);
    assert.equal((await f.publicCall(list, writer, 'POST', { ...input, query: { ...q, actorId: 'user-yun' } })).status, 400);
    assert.equal((await f.publicCall(`${list}?requestId=${input.requestId}`, writer, 'POST', input)).status, 400);

    const created = await f.publicCall<ReportSnapshot>(list, writer, 'POST', input);
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const snapshot = created.data;
    assert.equal(snapshot.actorId, 'user-seo');
    assert.equal(snapshot.report.current.state.done, 1);
    const documentPath = `/documents/${snapshot.documentId}`;
    const document = (await f.publicCall<DocPage>(documentPath, reader)).data;
    assert.equal(document.authorId, 'user-seo');
    assert.equal(document.status, 'draft');
    assert.equal(document.projectId, p.id);
    assert.equal(document.title, input.title);
    assert.deepEqual(contentReferences(document.content).map(reference => reference.id), [issue.id]);

    await change(f, issue, { status: 'todo', title: '확정 후 변경한 업무' });
    assert.equal((await report(f, q)).current.state.done, 0);
    const beforeRetries = (await f.call<Backup>('/export')).data;
    const retry = await f.publicCall<ReportSnapshot>(list, writer, 'POST', {
      query: { timeZone: q.timeZone, endDate: q.endDate, startDate: q.startDate, projectId: q.projectId },
      title: ` ${input.title} `, requestId: input.requestId.toUpperCase(),
    });
    assert.equal(retry.status, 200, JSON.stringify(retry.data));
    assert.deepEqual(retry.data, snapshot);
    assert.equal((await f.publicCall(list, otherWriter, 'POST', input)).status, 409);
    assert.equal((await f.publicCall(list, writer, 'POST', { ...input, title: '내용이 다른 주간 문서' })).status, 409);
    assert.equal((await f.publicCall(list, writer, 'POST', { ...input, query: { ...q, assigneeId: 'user-seo' } })).status, 409);
    const differentOperation = await f.call('/documents', 'POST', { requestId: input.requestId, title: input.title, projectId: p.id }, 'user-seo');
    assert.equal(differentOperation.status, 409);
    assert.equal(beforeRetries.revisions.filter(value => value.documentId === document.id && value.authorId === 'user-seo').length, 1);
    assert.equal(beforeRetries.activities.filter(value => value.resourceId === document.id && value.actorId === 'user-seo').length, 1);
    const afterRetries = (await f.call<Backup>('/export')).data;
    for (const key of ['documents', 'resourceLinks', 'activities', 'reportSnapshots', 'revisions'] as const) {
      assert.deepEqual(afterRetries[key], beforeRetries[key], key);
    }
    assert.equal(afterRetries.reportSnapshots.filter(value => value.documentId === document.id).length, 1);

    const moved = await f.call<DocPage>(documentPath, 'PATCH', { projectId: 'project-team', expectedVersion: document.version, title: '이동한 초안' });
    assert.equal(moved.status, 200, JSON.stringify(moved.data));
    assert.equal((await f.publicCall(documentPath, reader)).status, 403);
    assert.equal((await f.publicCall(list, writer, 'POST', input)).status, 409);
    assert.deepEqual((await f.publicCall<ReportSnapshot>(`${list}/${snapshot.id}`, reader)).data, snapshot);
    const summaries = await f.publicCall<ReportSnapshotSummary[]>(list, reader);
    assert.deepEqual(summaries.data.map(value => value.title), [input.title]);

    const removed = await f.call(documentPath, 'DELETE', { expectedVersion: moved.data.version });
    assert.equal(removed.status, 200, JSON.stringify(removed.data));
    assert.equal((await f.publicCall(list, writer, 'POST', input)).status, 409);
    assert.deepEqual((await f.publicCall<ReportSnapshot>(`${list}/${snapshot.id}`, reader)).data, snapshot);
  } finally { await f.close(); }
});

test('public weekly capture rolls back a failed receipt and can safely retry the same request', async () => {
  const f = await fixture(true);
  const db = new DatabaseSync(join(f.dir, 'donefac.sqlite'));
  try {
    const p = await project(f), q = query(p.id);
    await createIssue(f, p.id, '원자적으로 저장할 업무 연결');
    const writer = await reportKey(f, [p.id], 'write');
    const path = `/projects/${p.id}/report-snapshots`;
    const input = { requestId: randomUUID(), title: '저장 요청을 재시도할 주간 문서', query: q };
    const before = (await f.call<Backup>('/export')).data;
    db.exec("CREATE TRIGGER reject_weekly_receipt BEFORE INSERT ON document_creation_requests BEGIN SELECT RAISE(ABORT, 'synthetic weekly receipt storage failure'); END");
    const failed = await f.publicCall(path, writer, 'POST', input);
    assert.equal(failed.status, 500, JSON.stringify(failed.data));
    const afterFailure = (await f.call<Backup>('/export')).data;
    for (const key of ['documents', 'resourceLinks', 'activities', 'reportSnapshots', 'revisions'] as const) {
      assert.deepEqual(afterFailure[key], before[key], key);
    }
    db.exec('DROP TRIGGER reject_weekly_receipt');
    const successful = await f.publicCall<ReportSnapshot>(path, writer, 'POST', input);
    assert.equal(successful.status, 201, JSON.stringify(successful.data));
    const retry = await f.publicCall<ReportSnapshot>(path, writer, 'POST', input);
    assert.equal(retry.status, 200, JSON.stringify(retry.data));
    assert.deepEqual(retry.data, successful.data);
  } finally { db.close(); await f.close(); }
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
    const previousFormat = { ...backup, schemaVersion: 54, issueChangeHistory: undefined };
    const downgraded = await f.call<{ error: string }>('/import', 'POST', { data: previousFormat });
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

    const earlier = structuredClone(previousFormat), legacy = earlier.reportSnapshots[0];
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
