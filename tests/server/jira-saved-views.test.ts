import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { createIssueViewMatcher, orderProjectIssues } from '../../shared/issue-view.js';
import type {
  Issue, JiraSavedViewPreview, LegacyPackageSummary, MigrationApplyResult, MigrationOptions,
  MigrationPreview, ProjectIssueOrder, ProjectWorkflow, SavedView, WorkspaceSnapshot,
} from '../../shared/types.js';

const ACTOR = 'user-min';
const PROJECT_ID = 'project-neo';
const VIEWS = `/views?projectId=${PROJECT_ID}`;
const PREVIEW = '/views/jira/preview';
const IMPORT = '/views/jira/import';
const STALE = { code: 'stale_jira_view_preview' };

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-jira-saved-views-'));
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

  async function request<T = unknown>(path: string, method = 'GET', body?: unknown, status = 200, actor = ACTOR) {
    const response = await fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actor },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json() as T;
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
    return data;
  }
  const snapshot = () => request<WorkspaceSnapshot>('/workspace');
  const preview = (jql: string, projectId = PROJECT_ID) => request<JiraSavedViewPreview>(PREVIEW, 'POST', { projectId, jql });
  const addIssue = (title: string, labels: string[], projectId = PROJECT_ID) =>
    request<Issue>('/issues', 'POST', { projectId, title, labels }, 201);

  async function migrateJira(instanceKey: string, projects: { id: string; key: string }[], targetKey: string) {
    const issues = projects.map((project, i) => ({
      id: String(100 + i), key: `${project.key}-${i + 1}`,
      fields: {
        project: { ...project, name: project.key }, summary: `${project.key} imported issue`,
        created: '2020-01-01T00:00:00Z', updated: '2020-01-02T00:00:00Z',
        issuetype: { id: '3', name: 'Task' }, status: { id: '1', name: 'Open' },
      },
    }));
    const query = new URLSearchParams({ filename: 'synthetic.json', product: 'jira', instanceKey });
    const uploaded = await fetch(`${base}/legacy-import/packages?${query}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': ACTOR },
      body: new TextEncoder().encode(JSON.stringify({ issues })),
    });
    const pkg = await uploaded.json() as LegacyPackageSummary;
    assert.equal(uploaded.status, 201, JSON.stringify(pkg));
    const { defaultConfiguration } = await request<MigrationOptions>(`/migrations/options?packageId=${pkg.id}`);
    const configuration = {
      ...defaultConfiguration,
      projects: defaultConfiguration.projects.map(project => ({ ...project, key: targetKey, name: `${targetKey} local project` })),
    };
    const review = await request<MigrationPreview>('/migrations/preview', 'POST', { configuration }, 201);
    assert.ok(review.canApply, JSON.stringify(review.notices));
    const result = await request<MigrationApplyResult>(`/migrations/previews/${review.id}/apply`, 'POST', {
      expectedVersion: review.version, acknowledgements: review.requiredAcknowledgements,
    }, 201);
    assert.equal(result.import.projectIds.length, 1);
    return result.import.projectIds[0];
  }
  return { request, snapshot, preview, addIssue, migrateJira };
}

test('Jira saved-view preview follows shared filter semantics and manual rank, and imports an ordinary backup-safe view', async t => {
  const f = await fixture(t);
  const first = await f.addIssue('First release ticket', ['release']);
  const second = await f.addIssue('Second release ticket', ['release']);
  await f.addIssue('Case mismatch', ['Release']);
  await f.addIssue('Another project', ['release'], 'project-team');
  const orderPath = `/projects/${PROJECT_ID}/issue-order`;
  const order = await f.request<ProjectIssueOrder>(orderPath);
  const jql = 'project = NEO AND labels = "release" ORDER BY created DESC';
  const before = await f.snapshot();
  const firstReview = await f.preview(jql);
  assert.deepEqual(await f.preview(jql), firstReview);
  assert.deepEqual(firstReview.issues.map(issue => issue.id), [first.id, second.id]);
  assert.equal(firstReview.total, 2);
  assert.equal(firstReview.orderBy.length, 1);
  assert.match(firstReview.revision, /^[a-f0-9]{64}$/);
  const afterPreview = await f.snapshot();
  assert.deepEqual(afterPreview.savedViews, before.savedViews);
  assert.deepEqual(afterPreview.activities, before.activities);
  assert.deepEqual(afterPreview.issueOrders, before.issueOrders);
  await f.request(orderPath, 'PATCH', {
    issueId: second.id, expectedVersion: order.version, expectedIssueVersion: second.version, anchorId: first.id, position: 'before',
  });

  const input = { projectId: PROJECT_ID, jql, name: 'Jira release filter', layout: 'board', acceptProjectOrder: true };
  const stale = await f.request<{ details: unknown }>(IMPORT, 'POST', { ...input, revision: firstReview.revision }, 409);
  assert.deepEqual(stale.details, STALE);
  const review = await f.preview(jql);
  assert.deepEqual(review.issues.map(issue => issue.id), [second.id, first.id]);
  assert.notEqual(review.revision, firstReview.revision);
  await f.request(IMPORT, 'POST', { ...input, revision: review.revision, acceptProjectOrder: false }, 400);
  assert.deepEqual(await f.request(VIEWS), []);
  const view = await f.request<SavedView>(IMPORT, 'POST', { ...input, revision: review.revision }, 201);
  assert.equal(view.layout, 'board');
  assert.equal(view.authorId, ACTOR);
  assert.deepEqual(view.filters, review.filters);

  const current = await f.snapshot();
  const schema = current.issueSchemas?.find(value => value.projectId === PROJECT_ID);
  assert.ok(schema);
  const matches = createIssueViewMatcher(view.filters, current, schema);
  const matchOrder = current.issueOrders?.find(value => value.projectId === PROJECT_ID);
  assert.deepEqual(orderProjectIssues(current.issues.filter(issue => issue.projectId === PROJECT_ID && matches(issue)), matchOrder).map(issue => issue.id),
    review.issues.map(issue => issue.id));
  assert.deepEqual(await f.request(VIEWS), [view]);
  assert.equal(current.activities.filter(activity => activity.action === '업무 보기 저장' && activity.detail === view.name).length, 1);
  const duplicate = await f.request<{ details?: unknown }>(IMPORT, 'POST', { ...input, revision: review.revision }, 409);
  assert.equal(duplicate.details, undefined);

  const backup = await f.request<WorkspaceSnapshot>('/export');
  assert.deepEqual(backup.savedViews, [view]);
  assert.equal(JSON.stringify(backup).includes(jql), false);
  await f.request(`/views/${view.id}?expectedVersion=${view.version}`, 'DELETE');
  await f.request('/import', 'POST', { data: backup });
  assert.deepEqual(await f.request(VIEWS), [view]);
});

test('Jira save checks the full reviewed cohort and rejects an untranslatable or unchecked revision without writes', async t => {
  const f = await fixture(t);
  const issues: Issue[] = [];
  for (let i = 1; i <= 21; i++) issues.push(await f.addIssue(`Triage ticket ${i}`, ['triage']));
  const jql = 'project = NEO AND labels = triage';
  const review = await f.preview(jql);
  assert.equal(review.total, 21);
  assert.equal(review.issues.length, 20);
  assert.ok(!review.issues.some(issue => issue.id === issues[20].id));
  await f.request(PREVIEW, 'POST', { projectId: PROJECT_ID, jql: 'project = NEO OR status = todo' }, 400);
  await f.request(PREVIEW, 'POST', { projectId: PROJECT_ID, jql: 'project = TEAM' }, 400);
  await f.request(PREVIEW, 'POST', { projectId: PROJECT_ID, jql }, 400, 'unknown-actor');
  const fields = { projectId: PROJECT_ID, jql, name: 'Triage', layout: 'list', acceptProjectOrder: false, revision: review.revision };
  const mismatch = await f.request<{ details: unknown }>(IMPORT, 'POST', fields, 409, 'user-seo');
  assert.deepEqual(mismatch.details, STALE);
  await f.request(IMPORT, 'POST', { ...fields, revision: '' }, 400);

  const hidden = issues[20];
  await f.request(`/issues/${hidden.id}`, 'PATCH', { expectedVersion: hidden.version, title: 'Changed outside sample' });
  const afterEdit = await f.preview(jql);
  assert.deepEqual(afterEdit.issues, review.issues);
  assert.equal(afterEdit.total, review.total);
  assert.notEqual(afterEdit.revision, review.revision);
  const stale = await f.request<{ details: unknown }>(IMPORT, 'POST', fields, 409);
  assert.deepEqual(stale.details, STALE);

  const workflowPath = `/projects/${PROJECT_ID}/workflow`;
  const workflow = await f.request<ProjectWorkflow>(workflowPath);
  const initial = workflow.statuses.find(status => status.id === workflow.initialStatusId);
  assert.ok(initial);
  const statusJql = `project = NEO AND status = "${initial.label}"`;
  const statusReview = await f.preview(statusJql);
  await f.request(workflowPath, 'PATCH', {
    ...workflow, expectedVersion: workflow.version,
    statuses: workflow.statuses.map(status => status.id === initial.id ? { ...status, label: 'Renamed Jira status' } : status),
  });
  const unmapped = await f.request<{ details: unknown }>(IMPORT, 'POST', { ...fields, jql: statusJql, revision: statusReview.revision }, 409);
  assert.deepEqual(unmapped.details, STALE);
  assert.deepEqual(await f.request(VIEWS), []);
  await f.request(IMPORT, 'POST', { ...fields, revision: afterEdit.revision }, 201);
});

test('Jira project criteria recognize active archived original keys and numeric IDs, with explicit local scope for merged projects', async t => {
  const f = await fixture(t);
  const single = await f.migrateJira('single-jira', [{ id: '10400', key: 'OLD' }], 'RENAMED');
  const old = await f.preview('project = OLD', single);
  assert.deepEqual(old.issues, (await f.preview('project = 10400', single)).issues);
  assert.deepEqual(old.issues, (await f.preview('project = RENAMED', single)).issues);
  assert.equal(old.total, 1);
  await f.request(PREVIEW, 'POST', { projectId: PROJECT_ID, jql: 'project = OLD' }, 400);

  const merged = await f.migrateJira('merged-jira', [
    { id: '20001', key: 'MERGE' }, { id: '20002', key: 'SECOND' },
  ], 'MERGE');
  for (const alias of ['MERGE', 'SECOND', '20001', '20002']) {
    await f.request(PREVIEW, 'POST', { projectId: merged, jql: `project = ${alias}` }, 400);
  }
  assert.equal((await f.preview(`project = "${merged}"`, merged)).total, 2);
});
