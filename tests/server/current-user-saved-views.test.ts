import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type {
  ApiKeyCreated, DeliveryBlockerDraftResult, DeliveryBlockerReport, Issue, IssueBulkEditPreview,
  IssueFieldBreakdown, IssueFieldBreakdownPage, JiraSavedViewPreview, SavedView, WorkspaceSnapshot,
} from '../../shared/types.js';

const projectId = 'project-neo';
const firstActor = 'user-seo';
const secondActor = 'user-jun';
const marker = 'current-user-check';
const currentUser = { kind: 'current-user' } as const;
const filters = { query: marker, status: 'all', type: 'all', assigneeId: 'all', assignee: currentUser, reporter: currentUser };
const reportPath = `/projects/${projectId}/field-breakdown`;
const blockerPath = `/projects/${projectId}/delivery-blockers`;
const bulkPath = `/projects/${projectId}/issues/bulk`;

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'donefac-view-current-user-'));
  const runtime = createApp({ dataDir, outboundWorker: false });
  const server = runtime.app.listen(0, '127.0.0.1');
  t.after(async () => {
    try {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    } finally {
      runtime.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  async function call<T = unknown>(path: string, options: { method?: string; status?: number; actor?: string | null; token?: string; body?: unknown } = {}) {
    const { method = options.body === undefined ? 'GET' : 'POST', status = 200, actor = firstActor, token, body } = options;
    const response = await fetch(base + path, {
      method, headers: {
        'Content-Type': 'application/json', ...(actor ? { 'X-Actor-Id': actor } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json() as T;
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
    return data;
  }
  const addIssue = (title: string, assigneeId: string, reporterId: string) => call<Issue>('/issues', {
    status: 201, body: { projectId, title: `${marker} ${title}`, assigneeId, reporterId, labels: [marker] },
  });
  const addView = (name = '현재 사용자 보기', viewFilters: SavedView['filters'] = filters) => call<SavedView>('/views', {
    status: 201, body: { projectId, name, layout: 'board', filters: viewFilters },
  });
  return { call, addIssue, addView };
}

test('current-user views keep symbolic criteria across edits and require a compatible native backup', async t => {
  const { call, addView } = await fixture(t);
  const view = await addView();
  assert.deepEqual(view.filters, filters);
  for (const invalid of [
    { ...filters, assigneeId: firstActor },
    { ...filters, assignee: { kind: 'current-user', memberId: firstActor } },
    { ...filters, reporter: { kind: 'current-user', memberId: firstActor } },
  ]) await call('/views', { status: 400, body: { projectId, name: '잘못된 보기', layout: 'list', filters: invalid } });

  const renamed = await call<SavedView>(`/views/${view.id}`, { method: 'PATCH', actor: secondActor,
    body: { name: '팀의 현재 사용자 보기', expectedVersion: view.version } });
  assert.deepEqual(renamed.filters, filters);
  const backup = await call<WorkspaceSnapshot & { schemaVersion: number }>('/export');
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  const oldBackup = { ...backup, schemaVersion: 122 };
  for (const field of ['assignee', 'reporter'] as const) {
    const single = { ...renamed, filters: { ...renamed.filters } };
    delete single.filters[field];
    const denied = await call<{ error: string }>('/import', { status: 400, body: { data: { ...oldBackup, savedViews: [single] } } });
    assert.match(denied.error, /schemaVersion 123/u);
  }

  await call(`/views/${view.id}`, { method: 'PATCH', status: 409,
    body: { expectedVersion: view.version, filters: { ...filters, assignee: null } } });
  const fixed = await call<SavedView>(`/views/${view.id}`, { method: 'PATCH',
    body: { expectedVersion: renamed.version, filters: { ...filters, assigneeId: secondActor, assignee: null, reporter: null } } });
  assert.deepEqual(fixed.filters, { query: marker, status: 'all', type: 'all', assigneeId: secondActor });

  // An older backup containing only previously supported member filters still restores.
  const legacy = { ...oldBackup, savedViews: [fixed] };
  await call('/import', { body: { data: legacy } });
  const [legacyView] = await call<SavedView[]>(`/views?projectId=${projectId}`);
  assert.deepEqual(legacyView.filters, fixed.filters);
  await call('/import', { body: { data: backup } });
  const [restored] = await call<SavedView[]>(`/views?projectId=${projectId}`);
  assert.equal(restored.id, view.id);
  assert.ok(restored.version > fixed.version);
  assert.deepEqual(restored.filters, filters);
});

test('Jira currentUser() previews the selected actor and shares the symbolic criteria without capturing the previewer', async t => {
  const { call, addIssue } = await fixture(t);
  const first = await addIssue('담당 첫 사람', firstActor, secondActor);
  const second = await addIssue('요청 첫 사람', secondActor, firstActor);
  for (const [field, expected] of [['assignee', [first, second]], ['reporter', [second, first]]] as const) {
    const jql = `project = NEO AND labels = ${marker} AND ${field} = currentUser()`;
    const input = { projectId, jql };
    const a = await call<JiraSavedViewPreview>('/views/jira/preview', { body: input });
    const b = await call<JiraSavedViewPreview>('/views/jira/preview', { body: input, actor: secondActor });
    assert.deepEqual(a.issues.map(issue => issue.id), [expected[0].id]);
    assert.deepEqual(b.issues.map(issue => issue.id), [expected[1].id]);
    assert.deepEqual(a.filters[field], currentUser);
    assert.deepEqual(a.filters, b.filters);
    assert.notEqual(a.revision, b.revision);
    const withoutViewer = await call<JiraSavedViewPreview>('/views/jira/preview', { actor: null, body: { ...input, actorId: firstActor } });
    assert.equal(withoutViewer.total, 0);
    assert.notEqual(withoutViewer.revision, a.revision);
    const save = { ...input, revision: a.revision, name: `Jira ${field}`, layout: 'board', acceptProjectOrder: false };
    await call('/views/jira/import', { body: save, actor: secondActor, status: 409 });
    const view = await call<SavedView>('/views/jira/import', { body: save, status: 201 });
    assert.deepEqual(view.filters, a.filters);
    const summary = await call<IssueFieldBreakdown>(reportPath, { actor: secondActor, body: { savedViewId: view.id, groupBy: 'status' } });
    const page = await call<IssueFieldBreakdownPage>(`${reportPath}/issues`, { actor: secondActor, body: {
      savedViewId: view.id, groupBy: 'status', revision: summary.revision, bucketId: summary.groups.find(group => group.count > 0)?.id,
    } });
    assert.deepEqual(page.issues.map(issue => issue.id), [expected[1].id]);
  }
});

test('current-user reports, drilldowns and edit proofs follow the viewer and the API-key actor', async t => {
  const { call, addIssue, addView } = await fixture(t);
  const a = await addIssue('첫 사람의 업무', firstActor, firstActor);
  const b = await addIssue('둘째 사람의 업무', secondActor, secondActor);
  const other = await addIssue('담당자만 일치', firstActor, secondActor);
  for (const issue of [a, b, other]) await call(`/issues/${issue.id}/relations`, { status: 201,
    body: { otherIssueId: 'issue-1', type: 'blocks', direction: 'incoming' } });
  const view = await addView('GitLab 상태도 있는 현재 사용자 보기', { ...filters, gitlab: 'no_activity' });
  const empty = await addView('둘 다 결과가 없는 보기', { ...filters, query: '일치하는 업무가 없습니다' });
  const summary = { savedViewId: view.id, groupBy: 'status' };
  const report = `${blockerPath}?savedViewId=${view.id}`;
  const scope = await call<ApiKeyCreated>('/api-keys', {
    status: 201, body: { name: '현재 사용자 보기 읽기', access: 'read', projectIds: [projectId], expiresAt: null },
  });

  const first = await call<IssueFieldBreakdown>(reportPath, { body: summary });
  const second = await call<IssueFieldBreakdown>(reportPath, { actor: secondActor, body: summary });
  assert.equal(first.totalIssues, 1);
  assert.equal(second.totalIssues, 1);
  assert.notEqual(first.revision, second.revision);
  const selection = { ...summary, revision: first.revision, bucketId: first.groups.find(group => group.count > 0)?.id };
  const drill = await call<IssueFieldBreakdownPage>(`${reportPath}/issues`, { body: selection });
  assert.deepEqual(drill.issues.map(issue => issue.id), [a.id]);
  await call(`${reportPath}/issues`, { body: selection, actor: secondActor, status: 409 });
  const keyedDrill = await call<IssueFieldBreakdownPage>(`/v1${reportPath}/issues`, { actor: secondActor, token: scope.token, body: selection });
  assert.deepEqual(keyedDrill.issues.map(issue => issue.id), [a.id]);
  assert.equal((await call<IssueFieldBreakdown>(reportPath, { actor: null, body: { ...summary, actorId: firstActor } })).totalIssues, 0);

  const firstBlockers = await call<DeliveryBlockerReport>(report);
  const secondBlockers = await call<DeliveryBlockerReport>(report, { actor: secondActor });
  assert.deepEqual(firstBlockers.items.map(row => row.issue.id), [a.id]);
  assert.deepEqual(secondBlockers.items.map(row => row.issue.id), [b.id]);
  assert.deepEqual(firstBlockers.counts, secondBlockers.counts);
  assert.equal((await call<DeliveryBlockerReport>(`/v1${report}`, { actor: secondActor, token: scope.token })).revision, firstBlockers.revision);
  assert.equal((await call<DeliveryBlockerReport>(report, { actor: null })).counts.open, 0);
  assert.equal((await call<DeliveryBlockerReport>(report, { actor: 'unknown-viewer' })).counts.open, 0);
  await call(`${report}&revision=${firstBlockers.revision}`, { actor: secondActor, status: 409 });
  const emptyFirst = await call<DeliveryBlockerReport>(`${blockerPath}?savedViewId=${empty.id}`);
  const emptySecond = await call<DeliveryBlockerReport>(`${blockerPath}?savedViewId=${empty.id}`, { actor: secondActor });
  assert.equal(emptyFirst.total, 0);
  assert.equal(emptySecond.total, 0);
  assert.notEqual(emptyFirst.revision, emptySecond.revision);
  const emptySummary = { ...summary, savedViewId: empty.id };
  const emptyFieldFirst = await call<IssueFieldBreakdown>(reportPath, { body: emptySummary });
  const emptyFieldSecond = await call<IssueFieldBreakdown>(reportPath, { body: emptySummary, actor: secondActor });
  assert.equal(emptyFieldFirst.totalIssues, 0);
  assert.equal(emptyFieldSecond.totalIssues, 0);
  assert.notEqual(emptyFieldFirst.revision, emptyFieldSecond.revision);

  const draftSpec = { title: '검토할 현재 사용자 업무', requestId: randomUUID(), savedViewId: view.id, revision: firstBlockers.revision };
  await call(`${blockerPath}/meeting-draft`, { body: draftSpec, actor: secondActor, status: 409 });
  const draft = await call<DeliveryBlockerDraftResult>(`${blockerPath}/meeting-draft`, { body: draftSpec, status: 201 });
  const workspace = await call<WorkspaceSnapshot>('/workspace');
  assert.deepEqual(new Set(workspace.resourceLinks.filter(link => link.documentId === draft.document.id).map(link => link.issueId)),
    new Set([a.id, 'issue-1']));

  const proposal = { issues: [{ id: a.id, expectedVersion: a.version }], changes: { priority: 'urgent' }, fieldBreakdown: selection };
  const rejected = await call<{ details: { reason: string } }>(`${bulkPath}-preview`, { body: proposal, actor: secondActor, status: 409 });
  assert.equal(rejected.details.reason, 'field_breakdown_stale');
  const ready = await call<IssueBulkEditPreview>(`${bulkPath}-preview`, { body: proposal });
  assert.ok(ready.previewId);
  const apply = { previewId: ready.previewId };
  await call(`${bulkPath}-apply`, { body: apply, actor: secondActor, status: 404 });
  await call(`${bulkPath}-apply`, { body: apply });
  const saved = await call<WorkspaceSnapshot>('/workspace');
  assert.equal(saved.issues.find(issue => issue.id === a.id)?.priority, 'urgent');
  assert.deepEqual(saved.issues.find(issue => issue.id === b.id), b);
});
