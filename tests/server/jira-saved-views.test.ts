import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { createIssueViewMatcher, orderProjectIssues } from '../../shared/issue-view.js';
import type {
  Issue, JiraSavedViewPreview, LegacyPackageSummary, MigrationApplyResult, MigrationConfiguration, MigrationOptions,
  MigrationPreview, ProjectIssueOrder, ProjectIssueSchema, ProjectWorkflow, SavedView, SourceRecordArchive, User, WorkspaceSnapshot,
} from '../../shared/types.js';

const ACTOR = 'user-min';
const PROJECT_ID = 'project-neo';
const VIEWS = `/views?projectId=${PROJECT_ID}`;
const PREVIEW = '/views/jira/preview';
const IMPORT = '/views/jira/import';
const STALE = { code: 'stale_jira_view_preview' };

type JiraRestProfile = { key?: string; accountId?: string; name: string; emailAddress?: string };
type JiraRestValue = { id: string; name: string };
type JiraSourceIssue = {
  id: string;
  key: string;
  issueId?: string;
  fields?: {
    summary?: string; updated?: string; status?: JiraRestValue; issuetype?: JiraRestValue;
    assignee?: JiraRestProfile; reporter?: JiraRestProfile; creator?: JiraRestProfile;
  };
};

function mapSourceMembers(options: MigrationOptions, targets: Readonly<Record<string, string>>) {
  return {
    ...options.defaultConfiguration.users,
    ...Object.fromEntries(Object.entries(targets).map(([sourceValue, userId]) => {
      const entry = options.identities.find(identity => identity.sourceValue === sourceValue);
      assert.ok(entry, `Missing Jira identity: ${sourceValue}`);
      return [entry.id, userId];
    })),
  };
}

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

  async function migrateJira(instanceKey: string, sourceIssues: JiraSourceIssue[], targetKey: string,
    configure?: (options: MigrationOptions) => Partial<MigrationConfiguration>) {
    const issues = sourceIssues.map(({ id, key, issueId, fields }, index) => ({
      id: issueId ?? String(100 + index), key: `${key}-${issueId ?? index + 1}`,
      fields: {
        project: { id, key, name: key }, summary: `${key} imported issue`,
        created: '2020-01-01T00:00:00Z', updated: '2020-01-02T00:00:00Z',
        issuetype: { id: '3', name: 'Task' }, status: { id: '1', name: 'Open' }, ...fields,
      },
    }));
    const query = new URLSearchParams({ filename: 'synthetic.json', product: 'jira', instanceKey });
    const uploaded = await fetch(`${base}/legacy-import/packages?${query}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': ACTOR },
      body: new TextEncoder().encode(JSON.stringify({ issues })),
    });
    const pkg = await uploaded.json() as LegacyPackageSummary;
    assert.equal(uploaded.status, 201, JSON.stringify(pkg));
    const options = await request<MigrationOptions>(`/migrations/options?packageId=${pkg.id}`);
    const { defaultConfiguration } = options;
    const configuration = {
      ...defaultConfiguration,
      projects: defaultConfiguration.projects.map(project => ({ ...project, key: targetKey, name: `${targetKey} local project` })),
      ...configure?.(options),
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

test('Jira source user, status, and type values survive team renames, append, and backup restore', async t => {
  const f = await fixture(t);
  const origin = { id: '30500', key: 'OLDDEV' };
  const assignee = { key: 'JIRAUSER771', name: 'legacy_dev', emailAddress: 'legacy-dev@jira.example.test' };
  const reporter = { accountId: '10020:legacy-reporter', name: 'legacy_reporter' };
  const creator = { key: 'legacy-creator-key', name: 'legacy_creator' };
  const fields = { status: { id: '16895', name: 'Awaiting Dev' }, issuetype: { id: '10817', name: 'Dev Task' }, assignee, reporter, creator };
  const users = { [assignee.key]: ACTOR, [reporter.accountId]: 'user-seo', [creator.key]: 'user-jun' };
  const projectId = await f.migrateJira('one-appended-jira', [{ ...origin, fields, issueId: '400' }], 'RESTORED',
    options => ({ users: mapSourceMembers(options, users) }));
  const issue = (await f.snapshot()).issues.find(value => value.projectId === projectId);
  assert.ok(issue);
  assert.equal(issue.assigneeId, ACTOR);
  assert.equal(issue.reporterId, 'user-seo');
  await f.request<Issue>('/issues', 'POST', { projectId, title: 'Native task with no migrated members', reporterId: null }, 201);

  const jql = 'project = OLDDEV AND status = "Awaiting Dev" AND issuetype = "Dev Task" AND assignee = legacy_dev AND reporter = legacy_reporter';
  const initial = await f.preview(jql, projectId);
  assert.deepEqual(initial.issues.map(value => value.id), [issue.id]);
  assert.deepEqual(initial.filters, {
    query: '', status: issue.status, type: issue.type, assigneeId: ACTOR, reporter: { kind: 'member', memberId: 'user-seo' },
  });
  const sourceIds = `project = ${origin.id} AND status = ${fields.status.id} AND issuetype = ${fields.issuetype.id} AND assignee = ${assignee.key} AND reporter = "${reporter.accountId}"`;
  assert.deepEqual((await f.preview(sourceIds, projectId)).filters, initial.filters);
  assert.equal((await f.preview(`assignee = "${assignee.emailAddress}"`, projectId)).filters.assigneeId, ACTOR);
  const reporterAsAssignee = await f.preview('assignee = legacy_reporter', projectId);
  assert.equal(reporterAsAssignee.filters.assigneeId, 'user-seo');
  assert.equal(reporterAsAssignee.total, 0);
  const assigneeAsReporter = await f.preview('reporter = legacy_dev', projectId);
  assert.deepEqual(assigneeAsReporter.filters.reporter, { kind: 'member', memberId: ACTOR });
  assert.equal(assigneeAsReporter.total, 0);
  await f.request(PREVIEW, 'POST', { projectId, jql: 'reporter = legacy_creator' }, 400);

  const workflowPath = `/projects/${projectId}/workflow`;
  const schemaPath = `/projects/${projectId}/issue-schema`;
  const workflow = await f.request<ProjectWorkflow>(workflowPath);
  const schema = await f.request<ProjectIssueSchema>(schemaPath);
  const currentLabels = { status: '팀 개발 대기', type: '팀 개발 검토', assignee: '바뀐 담당자', reporter: '바뀐 요청자' };
  await f.request(workflowPath, 'PATCH', {
    ...workflow, expectedVersion: workflow.version,
    statuses: workflow.statuses.map(value => value.id === issue.status ? { ...value, label: currentLabels.status } : value),
  });
  await f.request(schemaPath, 'PATCH', {
    ...schema, expectedVersion: schema.version,
    issueTypes: schema.issueTypes.map(value => value.id === issue.type ? { ...value, name: currentLabels.type } : value),
  });
  await f.request(`/users/${ACTOR}`, 'PATCH', { name: currentLabels.assignee, email: 'renamed-assignee@example.test' });
  await f.request('/users/user-seo', 'PATCH', { name: currentLabels.reporter });
  const importInput = { projectId, jql, name: 'Restored Jira conditions', layout: 'list', acceptProjectOrder: false };
  const stale = await f.request<{ details: unknown }>(IMPORT, 'POST', { ...importInput, revision: initial.revision }, 409);
  assert.deepEqual(stale.details, STALE);
  const renamed = await f.preview(jql, projectId);
  assert.deepEqual(renamed.filters, initial.filters);
  assert.deepEqual(renamed.issues, initial.issues);
  for (const [field, label] of Object.entries(currentLabels)) {
    assert.ok(renamed.criteria.find(criterion => criterion.field === field)?.label.endsWith(label));
  }

  const nextAssignee = { ...assignee, name: 'appended_legacy_dev' };
  await f.migrateJira('one-appended-jira', [{ ...origin, fields: { ...fields, assignee: nextAssignee }, issueId: '401' }], 'RESTORED', options => ({
    users: mapSourceMembers(options, users),
    appendTo: {
      projectId,
      statuses: Object.fromEntries(options.statuses.map(status => [status.id, issue.status])),
      issueTypes: Object.fromEntries(options.issueTypes.map(type => [type.id, issue.type])),
      fields: {},
    },
  }));
  const appended = await f.preview(jql, projectId);
  assert.equal(appended.total, 2);
  assert.deepEqual((await f.preview(jql.replace(assignee.name, nextAssignee.name), projectId)).issues, appended.issues);
  assert.deepEqual(appended.filters, initial.filters);
  const saved = await f.request<SavedView>(IMPORT, 'POST', { ...importInput, revision: appended.revision }, 201);
  assert.deepEqual(saved.filters, initial.filters);
  const backup = await f.request<WorkspaceSnapshot>('/export');
  assert.deepEqual(backup.savedViews, [saved]);
  assert.doesNotMatch(JSON.stringify(backup.savedViews), /OLDDEV|legacy_dev|Awaiting Dev|Dev Task/);
  await f.request('/import', 'POST', { data: backup });
  const restored = await f.preview(jql, projectId);
  assert.deepEqual(restored.filters, appended.filters);
  assert.deepEqual(restored.issues, appended.issues);
});

test('Jira source aliases stay within a proven project and reject ambiguous native names and accounts', async t => {
  const f = await fixture(t);
  const conflict = { key: 'legacy-collision-key', name: 'legacy_collision' };
  const unmapped = { key: 'legacy-unmapped-key', name: 'legacy_unmapped' };
  const first = { key: 'legacy-first-key', name: 'legacy_first' };
  const second = { key: 'legacy-second-key', name: 'legacy_second' };
  const explicit = { key: 'legacy-selected-key', name: 'legacy_selected' };
  const origin = { id: '41900', key: 'SCOPED' };
  for (const person of [conflict, unmapped]) {
    await f.request<User>('/users', 'POST', { name: person.name, email: `${person.name}@example.test` }, 201);
  }
  const sourceIssues = [conflict, unmapped, first, explicit].map((assignee, index) => ({
    ...origin, issueId: String(500 + index), fields: { assignee },
  }));
  const projectId = await f.migrateJira('scoped-jira', [...sourceIssues, {
    ...origin, issueId: '504', fields: { reporter: second },
  }], 'SCOPEDLOCAL', options => ({ users: mapSourceMembers(options, {
    [conflict.key]: 'user-jun', [first.key]: 'user-seo', [second.key]: 'user-seo', [explicit.key]: ACTOR,
  }) }));

  for (const name of [conflict.name, unmapped.name, first.name, second.name]) {
    await f.request(PREVIEW, 'POST', { projectId, jql: `assignee = ${name}` }, 400);
  }
  await f.request(PREVIEW, 'POST', { projectId, jql: `assignee = ${first.name} AND assignee = ${second.name}` }, 400);
  assert.equal((await f.preview(`assignee = ${explicit.name}`, projectId)).total, 1);
  assert.equal((await f.preview(`assignee = "${ACTOR}"`, projectId)).total, 1);
  assert.equal((await f.preview('assignee = "user-seo"', projectId)).total, 1);
  assert.equal((await f.preview('reporter = "user-seo"', projectId)).total, 1);
  await f.request(PREVIEW, 'POST', { projectId: PROJECT_ID, jql: `assignee = ${explicit.name}` }, 400);

  const sibling = await f.migrateJira('scoped-jira', [{ id: '41901', key: 'SIBLING', issueId: '600' }], 'SIBLINGLOCAL');
  await f.request(PREVIEW, 'POST', { projectId: sibling, jql: `assignee = ${explicit.name}` }, 400);
  const merged = await f.migrateJira('scoped-merged-jira', [
    { id: '41902', key: 'MERGEDA', issueId: '700', fields: { assignee: explicit } },
    { id: '41903', key: 'MERGEDB', issueId: '701' },
  ], 'COMBINED', options => ({ users: mapSourceMembers(options, { [explicit.key]: ACTOR }) }));
  await f.request(PREVIEW, 'POST', { projectId: merged, jql: `project = COMBINED AND assignee = ${explicit.name}` }, 400);
  assert.equal((await f.preview(`project = COMBINED AND assignee = "${ACTOR}"`, merged)).total, 1);
});

test('Jira filter aliases use accepted refresh fields and keep the original mapping after a reordered restore', async t => {
  const f = await fixture(t);
  const instance = 'jira-refreshed-aliases';
  const origin = { id: '42000', key: 'REFRESH' };
  const first = { key: 'account-initial', name: 'initial_login' };
  const projectId = await f.migrateJira(instance, [{ ...origin, issueId: '800', fields: { assignee: first } }], 'REFRESHED',
    options => ({ users: mapSourceMembers(options, { [first.key]: ACTOR }) }));
  const issue = (await f.snapshot()).issues.find(item => item.projectId === projectId);
  assert.ok(issue);

  const later = { ...first, name: 'confirmed_login' };
  const newUser = { key: 'account-new-append', name: 'new_append_login' };
  const newer = { key: 'account-rejected', name: 'rejected_login' };
  const refresh = (options: MigrationOptions, members: Record<string, string>): Partial<MigrationConfiguration> => ({
    users: mapSourceMembers(options, members),
    appendTo: { projectId, refreshExisting: true,
      statuses: Object.fromEntries(options.statuses.map(status => [status.id, issue.status])),
      issueTypes: Object.fromEntries(options.issueTypes.map(type => [type.id, issue.type])), fields: {},
    },
  });
  await f.migrateJira(instance, [
    { ...origin, issueId: '800', fields: { assignee: later, updated: '2020-02-02T00:00:00Z' } },
    { ...origin, issueId: '801', fields: { assignee: newUser, updated: '2020-02-02T00:00:00Z' } },
  ], 'REFRESHED', options => refresh(options, { [first.key]: ACTOR, [newUser.key]: 'user-seo' }));
  const confirmed = await f.preview(`assignee = ${later.name}`, projectId);
  assert.deepEqual(confirmed.issues.map(item => item.id), [issue.id]);
  assert.equal((await f.preview(`assignee = ${newUser.name}`, projectId)).total, 1);

  const current = (await f.snapshot()).issues.find(item => item.id === issue.id)!;
  await f.request(`/issues/${issue.id}`, 'PATCH', { expectedVersion: current.version, assigneeId: 'user-jun' });
  await f.migrateJira(instance, [{ ...origin, issueId: '800', fields: { assignee: newer, summary: 'Accepted Jira title', updated: '2020-03-02T00:00:00Z' } }],
    'REFRESHED', options => refresh(options, { [newer.key]: 'user-seo' }));
  assert.equal((await f.snapshot()).issues.find(item => item.id === issue.id)?.assigneeId, 'user-jun');
  await f.request(PREVIEW, 'POST', { projectId, jql: `assignee = ${newer.name}` }, 400);

  const backup = await f.request<WorkspaceSnapshot & { sourceRecords: SourceRecordArchive[] }>('/export');
  assert.ok(backup.sourceRecords.some(item => item.targetId === issue.id && item.jiraIssueSourceFieldHashes?.assigneeId &&
    item.record.references.some(ref => ref.relation === 'assignee' && ref.sourceId === newer.key)));
  await f.request('/import', 'POST', { data: { ...backup, sourceRecords: backup.sourceRecords.slice().reverse() } });
  for (const name of [first.name, later.name]) {
    const result = await f.preview(`assignee = ${name}`, projectId);
    assert.equal(result.filters.assigneeId, ACTOR);
    assert.equal(result.total, 0);
  }
  assert.equal((await f.preview(`assignee = ${newUser.name}`, projectId)).total, 1);
  await f.request(PREVIEW, 'POST', { projectId, jql: `assignee = ${newer.name}` }, 400);
});
