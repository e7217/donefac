import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { importedCustomFieldOptionId } from '../../server/migration-planner.js';
import { createIssueViewMatcher, orderProjectIssues } from '../../shared/issue-view.js';
import type {
  Issue, JiraSavedViewPreview, LegacyPackageSummary, MigrationApplyResult, MigrationConfiguration, MigrationOptions,
  MigrationPreview, Project, ProjectIssueOrder, ProjectIssueSchema, ProjectWorkflow, SavedView, SourceRecordArchive, User, WorkspaceSnapshot,
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
    summary?: string; updated?: string; status?: JiraRestValue; issuetype?: JiraRestValue; duedate?: string | null; priority?: JiraRestValue;
    assignee?: JiraRestProfile; reporter?: JiraRestProfile; creator?: JiraRestProfile; components?: JiraRestValue[];
    fixVersions?: JiraRestValue[];
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

  async function reviewJiraMigration(instanceKey: string, sourceIssues: JiraSourceIssue[] | string, targetKey: string,
    configure?: (options: MigrationOptions) => Partial<MigrationConfiguration>) {
    const csv = typeof sourceIssues === 'string';
    const payload = csv ? sourceIssues : JSON.stringify({
      issues: sourceIssues.map(({ id, key, issueId, fields }, index) => ({
        id: issueId ?? String(100 + index), key: `${key}-${issueId ?? index + 1}`,
        fields: {
          project: { id, key, name: key }, summary: `${key} imported issue`,
          created: '2020-01-01T00:00:00Z', updated: '2020-01-02T00:00:00Z',
          issuetype: { id: '3', name: 'Task' }, status: { id: '1', name: 'Open' }, ...fields,
        },
      })),
    });
    const query = new URLSearchParams({ filename: csv ? 'synthetic.csv' : 'synthetic.json', product: 'jira', instanceKey });
    const uploaded = await fetch(`${base}/legacy-import/packages?${query}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': ACTOR },
      body: new TextEncoder().encode(payload),
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
    return request<MigrationPreview>('/migrations/preview', 'POST', { configuration }, 201);
  }

  async function migrateJira(...args: Parameters<typeof reviewJiraMigration>) {
    const review = await reviewJiraMigration(...args);
    assert.ok(review.canApply, JSON.stringify(review.notices));
    const result = await request<MigrationApplyResult>(`/migrations/previews/${review.id}/apply`, 'POST', {
      expectedVersion: review.version, acknowledgements: review.requiredAcknowledgements,
    }, 201);
    assert.equal(result.import.projectIds.length, 1);
    return result.import.projectIds[0];
  }
  return { request, snapshot, preview, addIssue, migrateJira, reviewJiraMigration };
}

test('Jira saved-view preview follows shared filter semantics and manual rank, and imports an ordinary backup-safe view', async t => {
  const f = await fixture(t);
  const first = await f.addIssue('First release ticket', ['release']);
  const second = await f.addIssue('Second release ticket', ['release']);
  await f.addIssue('Case mismatch', ['Release']);
  await f.addIssue('Another project', ['release'], 'project-team');
  const orderPath = `/projects/${PROJECT_ID}/issue-order`;
  const order = await f.request<ProjectIssueOrder>(orderPath);
  const jql = 'project = NEO AND labels = "release" ORDER BY Rank ASC';
  const before = await f.snapshot();
  const firstReview = await f.preview(jql);
  assert.deepEqual(await f.preview(jql), firstReview);
  assert.deepEqual(firstReview.issues.map(issue => issue.id), [first.id, second.id]);
  assert.equal(firstReview.total, 2);
  assert.equal(firstReview.orderBy.length, 1);
  assert.equal(firstReview.requiresProjectOrderAcceptance, true);
  assert.equal(firstReview.sort, undefined);
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

test('explicit Jira date order previews and persists the sorted view without changing project rank', async t => {
  const f = await fixture(t);
  const projectId = await f.migrateJira('saved-view-date-order', [
    { id: '20001', key: 'SOURCE', fields: { summary: 'Date missing', updated: '2026-11-27T09:00:00Z' } },
    { id: '20001', key: 'SOURCE', fields: { summary: 'Later deadline', duedate: '2026-11-27', updated: '2026-11-26T09:00:00Z' } },
    { id: '20001', key: 'SOURCE', fields: { summary: 'Earlier deadline, old update', duedate: '2026-11-24', updated: '2026-11-24T09:00:00Z' } },
    { id: '20001', key: 'SOURCE', fields: { summary: 'Earlier deadline, new update', duedate: '2026-11-24', updated: '2026-11-25T09:00:00Z' } },
  ], 'MIGSORT');
  const snapshot = await f.snapshot();
  const projectIssues = snapshot.issues.filter(issue => issue.projectId === projectId);
  const [missing, late, old, recent] = ['Date missing', 'Later deadline', 'Earlier deadline, old update', 'Earlier deadline, new update']
    .map(title => projectIssues.find(issue => issue.title === title)!);
  const orderPath = `/projects/${projectId}/issue-order`;
  const originalRank = await f.request<ProjectIssueOrder>(orderPath);
  const jql = 'project = SOURCE ORDER BY dueDate ASC, updated DESC';
  const review = await f.preview(jql, projectId);
  assert.deepEqual(review.sort, [{ field: 'dueDate', direction: 'asc' }, { field: 'updatedAt', direction: 'desc' }]);
  assert.equal(review.requiresProjectOrderAcceptance, undefined);
  assert.deepEqual(review.issues.map(issue => issue.id), [recent.id, old.id, late.id, missing.id]);
  const fallback = await f.preview('project = SOURCE ORDER BY due ASC, priority DESC', projectId);
  assert.equal(fallback.requiresProjectOrderAcceptance, true);
  assert.equal(fallback.sort, undefined);
  assert.deepEqual(fallback.issues.map(issue => issue.id), originalRank.issueIds);

  await f.request(`/issues/${late.id}`, 'PATCH', { expectedVersion: late.version, dueDate: '2026-11-23' });
  const input = { projectId, jql, name: 'Jira date sort', layout: 'list', acceptProjectOrder: false };
  const stale = await f.request<{ details: unknown }>(IMPORT, 'POST', { ...input, revision: review.revision }, 409);
  assert.deepEqual(stale.details, STALE);
  const fresh = await f.preview(jql, projectId);
  assert.deepEqual(fresh.issues.map(issue => issue.id), [late.id, recent.id, old.id, missing.id]);
  const saved = await f.request<SavedView>(IMPORT, 'POST', { ...input, revision: fresh.revision }, 201);
  assert.deepEqual(saved.sort, fresh.sort);
  assert.deepEqual(await f.request(`/views?projectId=${projectId}`), [saved]);
  assert.deepEqual(await f.request(orderPath), originalRank);
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

test('Jira component criteria survive native choice rename and save as a live backup-safe field filter', async t => {
  const f = await fixture(t);
  const origin = { id: '24100', key: 'COMPONENTS' };
  const api = { id: '24201', name: 'REST API' };
  const web = { id: '24202', name: 'Web UI' };
  const [apiOnly, webOnly, both, empty] = ['API only', 'Web only', 'Both components', 'Explicitly empty'];
  const projectId = await f.migrateJira('jira-saved-component', [
    { ...origin, fields: { summary: apiOnly, components: [api], duedate: '2026-11-22' } },
    { ...origin, fields: { summary: webOnly, components: [web], duedate: '2026-11-23' } },
    { ...origin, fields: { summary: both, components: [api, web], duedate: '2026-11-24' } },
    { ...origin, fields: { summary: empty, components: [], duedate: '2026-11-22' } },
  ], 'TEAMCOMP');
  const schemaPath = `/projects/${projectId}/issue-schema`;
  const schema = await f.request<ProjectIssueSchema>(schemaPath);
  const componentField = schema.fields.find(field => field.name === 'Jira 컴포넌트');
  assert.equal(componentField?.kind, 'multi_select');
  const apiOption = componentField.options.find(value => value.name === api.name);
  const webOption = componentField.options.find(value => value.name === web.name);
  assert.ok(apiOption && webOption);
  const nameCondition = `component = "${api.name}"`;
  const titled = (result: JiraSavedViewPreview) => result.issues.map(issue => issue.title).sort();
  const original = await f.preview(nameCondition, projectId);
  const renamedChoice = 'Integration layer';
  await f.request(schemaPath, 'PATCH', {
    ...schema, expectedVersion: schema.version,
    fields: schema.fields.map(field => field.id === componentField.id ? {
      ...field, options: field.options.map(option => option.id === apiOption.id ? { ...option, name: renamedChoice } : option),
    } : field),
  });
  const renamed = await f.preview(nameCondition, projectId);
  assert.deepEqual(renamed.filters, original.filters);
  assert.deepEqual(renamed.issues, original.issues);
  assert.notEqual(renamed.revision, original.revision);
  assert.ok(renamed.criteria.find(criterion => criterion.field === 'component')?.label.includes(renamedChoice));

  const queries: [string, string[]][] = [
    [nameCondition, [apiOnly, both]],
    [`project = ${origin.id} AND component = ${api.id}`, [apiOnly, both]],
    [`component IN (${api.id}, "${web.name}")`, [apiOnly, webOnly, both]],
    [`${nameCondition} OR component = ${web.id}`, [apiOnly, webOnly, both]],
    [`${nameCondition} AND component = ${web.id}`, [both]],
    [`component != ${api.id}`, [webOnly]],
    [`component NOT IN (${api.id}, ${web.id})`, []],
    ['component IS EMPTY', [empty]],
    ['component IS NOT EMPTY', [apiOnly, webOnly, both]],
  ];
  for (const [jql, expected] of queries) {
    const review = await f.preview(jql, projectId);
    assert.equal(review.total, expected.length, jql);
    assert.deepEqual(titled(review), expected.toSorted(), jql);
  }
  for (const value of ['999999', '"Unknown component"', `"${renamedChoice}"`]) {
    const rejected = await f.request<{ error: string }>(PREVIEW, 'POST', { projectId, jql: `component = ${value}` }, 400);
    assert.match(rejected.error, /컴포넌트/u);
  }

  const jql = `project = ${origin.key} AND component IN (${api.id}, ${web.id}) AND due <= "2026-11-23"`;
  const beforeEdit = await f.preview(jql, projectId);
  assert.deepEqual(titled(beforeEdit), [apiOnly, webOnly]);
  const fieldFilter = beforeEdit.filters.fieldFilter;
  assert.equal(fieldFilter?.match, 'any');
  assert.deepEqual(fieldFilter.rules.toSorted((left, right) => String(left.value).localeCompare(String(right.value))),
    [apiOption.id, webOption.id].sort((left, right) => left.localeCompare(right))
      .map(value => ({ fieldId: componentField.id, operator: 'includes', value })));

  const snapshot = await f.snapshot();
  const rescheduled = snapshot.issues.find(issue => issue.projectId === projectId && issue.title === both);
  assert.ok(rescheduled);
  await f.request(`/issues/${rescheduled.id}`, 'PATCH', { expectedVersion: rescheduled.version, dueDate: '2026-11-23' });
  const input = { projectId, jql, name: 'Jira component due dates', layout: 'board', acceptProjectOrder: false };
  const stale = await f.request<{ details: unknown }>(IMPORT, 'POST', { ...input, revision: beforeEdit.revision }, 409);
  assert.deepEqual(stale.details, STALE);
  const fresh = await f.preview(jql, projectId);
  assert.deepEqual(titled(fresh), [apiOnly, both, webOnly]);
  const saved = await f.request<SavedView>(IMPORT, 'POST', { ...input, revision: fresh.revision }, 201);
  assert.equal(saved.layout, 'board');
  assert.deepEqual(saved.filters, fresh.filters);
  const backup = await f.request<WorkspaceSnapshot>('/export');
  await f.request('/import', 'POST', { data: backup });
  const [restored] = await f.request<SavedView[]>(`/views?projectId=${projectId}`);
  assert.deepEqual(restored.filters, saved.filters);
  const current = await f.snapshot();
  const restoredSchema = await f.request<ProjectIssueSchema>(schemaPath);
  assert.deepEqual(current.issues.filter(createIssueViewMatcher(restored.filters, current, restoredSchema)).map(issue => issue.title).sort(),
    titled(fresh));
  assert.deepEqual((await f.preview(nameCondition, projectId)).issues, original.issues);
});

test('Jira component preview requires a proven source project and distinguishes omitted data from empty values', async t => {
  const f = await fixture(t);
  const component = { id: '24301', name: 'Shared' };
  const source = { id: '24300', key: 'COMPVALID' };
  const known = { ...source, fields: { summary: 'Component provided', components: [component] } };
  const projectId = await f.migrateJira('component-partial', [known, { ...source, fields: { summary: 'Component omitted' } }], 'TEAMVALID');
  const review = await f.preview(`component = ${component.name}`, projectId);
  assert.deepEqual(review.issues.map(value => value.title), [known.fields.summary]);
  await f.request(PREVIEW, 'POST', { projectId, jql: 'component IS EMPTY' }, 400);
  await f.request(PREVIEW, 'POST', { projectId, jql: `component != ${component.id}` }, 400);

  const merged = await f.migrateJira('component-merged-projects', [known, {
    id: '24400', key: 'COMPOTHER', fields: { components: [{ ...component, id: '24401' }] },
  }], 'TEAMMERGED');
  assert.equal((await f.preview(`project = "${merged}"`, merged)).total, 2);
  await f.request(PREVIEW, 'POST', { projectId: merged, jql: `project = "${merged}" AND component = ${component.name}` }, 400);
  await f.request(PREVIEW, 'POST', { projectId: PROJECT_ID, jql: `component = ${component.id}` }, 400);
});

test('Jira component preview uses proven append mappings and rejects a later key for an earlier name-only assignment', async t => {
  const f = await fixture(t);
  const instance = 'jira-component-append';
  const origin = { id: '24500', key: 'COMPRUN' };
  const targetKey = 'TEAMRUN';
  const projectId = await f.migrateJira(instance, [{ ...origin, issueId: '24511' }], targetKey);
  const baseline = (await f.snapshot()).issues.find(issue => issue.projectId === projectId);
  assert.ok(baseline);
  const schemaPath = `/projects/${projectId}/issue-schema`;
  const schema = await f.request<ProjectIssueSchema>(schemaPath);
  const practices = { id: '24501', name: 'Runbooks' };
  const tooling = { id: '24502', name: 'Automation' };
  const nativeByName = { id: 'team_runbooks', name: practices.name, archived: false };
  const field = { id: 'team_area', name: 'Team area', kind: 'multi_select', description: '', required: false,
    issueTypes: [], archived: false, options: [nativeByName] };
  const withNativeField = await f.request<ProjectIssueSchema>(schemaPath, 'PATCH', {
    ...schema, expectedVersion: schema.version, fields: [...schema.fields, field],
  });
  const append = (issues: JiraSourceIssue[]) => f.migrateJira(instance, issues, targetKey, options => {
    const componentField = options.fields.find(option => option.sourceValue === 'jira:components');
    assert.ok(componentField);
    return { appendTo: {
      projectId,
      statuses: Object.fromEntries(options.statuses.map(option => [option.id, baseline.status])),
      issueTypes: Object.fromEntries(options.issueTypes.map(option => [option.id, baseline.type])),
      fields: { [componentField.id]: field.id },
    } };
  });
  const firstTitle = 'First runbook imported by name';
  await append([{ ...origin, issueId: '24512', fields: { summary: firstTitle, components: [practices] } }]);
  const byName = (await f.snapshot()).issues.find(issue => issue.projectId === projectId && issue.title === firstTitle);
  assert.deepEqual(byName?.customFields?.[field.id], [nativeByName.id]);

  const keyedPractice = importedCustomFieldOptionId(field.id, practices.id);
  const keyedTooling = importedCustomFieldOptionId(field.id, tooling.id);
  await f.request(schemaPath, 'PATCH', {
    ...withNativeField, expectedVersion: withNativeField.version, fields: withNativeField.fields.map(value => value.id === field.id ? {
      ...value, options: [...value.options, { id: keyedPractice, name: 'Jira runbooks', archived: false },
        { id: keyedTooling, name: 'Jira automation', archived: false }],
    } : value),
  });
  const keyedTitle = 'Second runbook imported by key';
  const toolingTitle = 'Automation imported by key';
  await append([
    { ...origin, issueId: '24513', fields: { summary: keyedTitle, components: [practices] } },
    { ...origin, issueId: '24514', fields: { summary: toolingTitle, components: [tooling] } },
  ]);
  const current = (await f.snapshot()).issues.filter(issue => issue.projectId === projectId);
  for (const [title, id] of [[firstTitle, nativeByName.id], [keyedTitle, keyedPractice], [toolingTitle, keyedTooling]]) {
    assert.deepEqual(current.find(issue => issue.title === title)?.customFields?.[field.id], [id], title);
  }

  const known = await f.preview(`component = ${tooling.id}`, projectId);
  assert.deepEqual(known.issues.map(issue => issue.title), [toolingTitle]);
  assert.deepEqual((await f.preview(`component = ${tooling.name}`, projectId)).filters, known.filters);
  for (const value of [practices.id, practices.name]) {
    const unproven = await f.request<{ error: string }>(PREVIEW, 'POST', { projectId, jql: `component = ${value}` }, 400);
    assert.match(unproven.error, /컴포넌트/u);
  }
});

test('Jira deadline saved views match imported source dates and preserve native date bounds in backup', async t => {
  const f = await fixture(t);
  const origin = { id: '41250', key: 'LEGDATE' };
  const dueDates = ['2024-02-28', '2024-02-29', '2024-03-01', '2024-03-02', null];
  const projectId = await f.migrateJira('source-dates', dueDates.map((duedate, index) => ({
    ...origin, issueId: String(1100 + index), fields: { duedate, summary: `Ticket with due date ${duedate ?? 'unset'}` },
  })), 'TEAMDATED');
  const imported = (await f.snapshot()).issues.filter(issue => issue.projectId === projectId);
  assert.deepEqual(new Set(imported.map(issue => issue.dueDate)), new Set(dueDates));
  const expected = imported.filter(issue => issue.dueDate === '2024-02-29' || issue.dueDate === '2024-03-01').map(issue => issue.id).sort();
  const jql = `project = ${origin.key} AND dueDate >= "2024/02/29" AND due < "2024-03-02"`;
  const review = await f.preview(jql, projectId);
  const planning = { dates: { mode: 'due', from: '2024-02-29', to: '2024-03-01' } };
  assert.deepEqual(review.filters.planning, planning);
  assert.deepEqual(review.issues.map(issue => issue.id).sort(), expected);
  assert.equal(review.total, 2);
  const view = await f.request<SavedView>(IMPORT, 'POST', {
    projectId, jql, name: 'Jira deadline window', layout: 'board', acceptProjectOrder: false, revision: review.revision,
  }, 201);
  assert.deepEqual(view.filters, review.filters);

  const missingJql = `project = ${origin.key} AND dueDate IS EMPTY`;
  const missing = await f.preview(missingJql, projectId);
  assert.deepEqual(missing.filters.planning, { dates: { mode: 'due_missing' } });
  assert.deepEqual(missing.issues.map(issue => issue.id), imported.filter(issue => issue.dueDate === null).map(issue => issue.id));
  const dated = await f.preview('due IS NOT NULL', projectId);
  assert.deepEqual(dated.filters.planning, { dates: { mode: 'due_set' } });
  assert.deepEqual(dated.issues.map(issue => issue.id).sort(), imported.filter(issue => issue.dueDate !== null).map(issue => issue.id).sort());
  assert.deepEqual((await f.preview(`${jql} AND due IS NOT EMPTY`, projectId)).filters, review.filters);
  for (const invalidJql of ['due IS EMPTY AND due IS NOT NULL', 'due IS NULL AND due < "2024-03-02"', 'due IS NOT today']) {
    await f.request(PREVIEW, 'POST', { projectId, jql: invalidJql }, 400);
  }
  const missingView = await f.request<SavedView>(IMPORT, 'POST', {
    projectId, jql: missingJql, name: 'Jira missing deadline', layout: 'list', acceptProjectOrder: false, revision: missing.revision,
  }, 201);

  await f.request(PREVIEW, 'POST', { projectId, jql: `project = ${origin.key} AND due >= startOfWeek()` }, 400);
  const invalid = await f.reviewJiraMigration('invalid-source-date', [{
    id: '41251', key: 'LEGINVALID', fields: { duedate: 'not-a-date' },
  }], 'TEAMINVALID');
  assert.equal(invalid.canApply, false);
  assert.ok(invalid.notices.some(notice => notice.severity === 'error' && notice.code === 'DATE_UNRESOLVED'));
  const backup = await f.request<WorkspaceSnapshot & { schemaVersion: number }>('/export');
  assert.equal(backup.schemaVersion, 127);
  const older = await f.request<{ error: string }>('/import', 'POST', { data: { ...backup, schemaVersion: 123 } }, 400);
  assert.match(older.error, /schemaVersion 124/u);
  await f.request(`/views/${view.id}?expectedVersion=${view.version}`, 'DELETE');
  await f.request(`/views/${missingView.id}?expectedVersion=${missingView.version}`, 'DELETE');
  await f.request('/import', 'POST', { data: backup });
  const restored = await f.request<SavedView[]>(`/views?projectId=${projectId}`);
  assert.equal(restored.length, 2);
  assert.deepEqual(restored.find(saved => saved.id === view.id), view);
  assert.deepEqual(restored.find(saved => saved.id === missingView.id), missingView);
});

test('Jira rolling deadlines move at Seoul midnight and survive export without freezing the reviewed dates', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2024-02-28T14:59:00Z') });
  const f = await fixture(t);
  const dates = ['2024-02-27', '2024-02-28', '2024-02-29', '2024-03-01', null];
  const tickets: Issue[] = [];
  for (const dueDate of dates) {
    tickets.push(await f.request<Issue>('/issues', 'POST', {
      projectId: PROJECT_ID, title: `Rolling deadline ${dueDate ?? 'unset'}`, labels: ['rolling-deadline'], dueDate,
    }, 201));
  }
  const scope = 'labels = "rolling-deadline" AND ';
  const jql = scope + 'due < startOfDay()';
  const review = await f.preview(jql);
  assert.deepEqual(review.filters.planning, { dates: { mode: 'due_relative', toDays: -1 } });
  assert.deepEqual(review.issues.map(issue => issue.id), [tickets[0].id]);
  const range = await f.preview(scope + 'due >= startOfDay() AND due < endOfDay("+1d") AND due >= "2024/02/29"');
  assert.deepEqual(range.filters.planning, { dates: { mode: 'due_relative', fromDays: 0, toDays: 1, from: '2024-02-29' } });
  assert.deepEqual(range.issues.map(issue => issue.id), [tickets[2].id]);
  const fromTomorrow = await f.preview(scope + 'due > endOfDay()');
  assert.deepEqual(fromTomorrow.filters.planning, { dates: { mode: 'due_relative', fromDays: 1 } });
  const today = await f.preview(scope + 'due = STARTOFDAY()');
  assert.deepEqual(today.issues.map(issue => issue.id), [tickets[1].id]);

  for (const invalid of ['due >= startOfDay("+1h")', 'due = endOfDay()', 'due >= startOfWeek()',
    'due IS EMPTY AND due < startOfDay()', 'due > startOfDay() AND due < startOfDay()', 'due > startOfDay("+3650d")']) {
    await f.request(PREVIEW, 'POST', { projectId: PROJECT_ID, jql: invalid }, 400);
  }

  const importView = { projectId: PROJECT_ID, jql, name: 'Jira rolling deadlines', layout: 'list', acceptProjectOrder: false };
  t.mock.timers.setTime(Date.parse('2024-02-28T15:00:00Z'));
  const stale = await f.request<{ details: unknown }>(IMPORT, 'POST', { ...importView, revision: review.revision }, 409);
  assert.deepEqual(stale.details, STALE);
  const afterMidnight = await f.preview(jql);
  assert.deepEqual(afterMidnight.issues.map(issue => issue.id).sort(), [tickets[0].id, tickets[1].id].sort());
  assert.deepEqual(afterMidnight.filters, review.filters);
  const view = await f.request<SavedView>(IMPORT, 'POST', { ...importView, revision: afterMidnight.revision }, 201);
  const backup = await f.request<WorkspaceSnapshot & { schemaVersion: number }>('/export');
  assert.equal(backup.schemaVersion, 127);
  const older = await f.request<{ error: string }>('/import', 'POST', { data: { ...backup, schemaVersion: 124 } }, 400);
  assert.match(older.error, /schemaVersion 125/u);
  await f.request(`/views/${view.id}?expectedVersion=${view.version}`, 'DELETE');
  await f.request('/import', 'POST', { data: backup });
  assert.deepEqual((await f.request<SavedView[]>(VIEWS)).find(saved => saved.id === view.id), view);
});

test('Jira release filters distinguish an omitted REST field from an explicitly empty version list', async t => {
  const f = await fixture(t);
  const project = { id: '24510', key: 'FIXMISS' };
  const projectId = await f.migrateJira('fix-version-incomplete', [
    { ...project, issueId: '2001', fields: { summary: 'Known release', fixVersions: [{ id: '3001', name: 'Known version' }] } },
    { ...project, issueId: '2002', fields: { summary: 'Explicit empty', fixVersions: [] } },
    { ...project, issueId: '2003', fields: { summary: 'Omitted field' } },
  ], 'TEAMFIX');
  for (const jql of ['fixVersion = 3001', 'fixVersion IS EMPTY', 'fixVersion IS NOT EMPTY']) {
    const error = await f.request<{ error: string }>(PREVIEW, 'POST', { projectId, jql }, 400);
    assert.match(error.error, /전체 배정을 확인할 수 없습니다/u);
  }
});

test('Jira multi-status saved views preserve original aliases while reviewing current workflow names', async t => {
  const f = await fixture(t);
  const origin = { id: '40300', key: 'LEGSTAT' };
  const [intake, review, closed] = [
    { id: '13101', name: 'Requested' }, { id: '13102', name: 'Legacy review' }, { id: '13103', name: 'Finished' },
  ];
  const projectId = await f.migrateJira('multi-status-source', [intake, review, closed].map((status, index) => ({
    ...origin, issueId: String(1100 + index), fields: { status, summary: status.name },
  })), 'TEAMINTAKE');
  const sourceIssues = (await f.snapshot()).issues.filter(issue => issue.projectId === projectId);
  const expectedIssues = sourceIssues.filter(issue => issue.title !== closed.name);
  assert.equal(expectedIssues.length, 2);
  const expectedStatuses = expectedIssues.map(issue => issue.status).sort();
  const jql = `project = ${origin.key} AND status IN (${intake.id}, "${review.name}", "${intake.name}")`;
  const or = `project = ${origin.key} AND (status = ${intake.id} OR status = "${review.name}")`;
  const initial = await f.preview(jql, projectId);
  assert.deepEqual(initial.issues.map(issue => issue.id).sort(), expectedIssues.map(issue => issue.id).sort());
  assert.deepEqual(initial.filters.statusIds, expectedStatuses);
  assert.deepEqual((await f.preview(or, projectId)).filters, initial.filters);
  await f.request(PREVIEW, 'POST', { projectId, jql: `project = ${origin.key} AND status = ${intake.id} OR status = "${review.name}"` }, 400);
  await f.request(PREVIEW, 'POST', { projectId, jql: `status IN (${intake.id}, 99999) AND status = ${intake.id}` }, 400);

  const workflowPath = `/projects/${projectId}/workflow`;
  const workflow = await f.request<ProjectWorkflow>(workflowPath);
  const labels = ['현재 접수', '현재 기술 검토'];
  await f.request(workflowPath, 'PATCH', {
    ...workflow, expectedVersion: workflow.version,
    statuses: workflow.statuses.map(status => {
      const index = expectedStatuses.indexOf(status.id);
      return index < 0 ? status : { ...status, label: labels[index] };
    }),
  });
  const input = { projectId, jql, name: 'Migrated status union', layout: 'board', acceptProjectOrder: false };
  const stale = await f.request<{ details: unknown }>(IMPORT, 'POST', { ...input, revision: initial.revision }, 409);
  assert.deepEqual(stale.details, STALE);
  const next = await f.preview(jql, projectId);
  assert.deepEqual(next.issues, initial.issues);
  assert.deepEqual(next.criteria.find(value => value.field === 'status'), { field: 'status', label: `상태 · ${labels.join(', ')}` });
  const one = await f.preview(`${or} AND status = "${review.name}"`, projectId);
  assert.equal(one.filters.status, expectedIssues.find(issue => issue.title === review.name)?.status);
  assert.equal(one.filters.statusIds, undefined);

  const saved = await f.request<SavedView>(IMPORT, 'POST', { ...input, revision: next.revision }, 201);
  assert.deepEqual(saved.filters, next.filters);
  const backup = await f.request<WorkspaceSnapshot>('/export');
  assert.deepEqual(backup.savedViews, [saved]);
  await f.request(`/views/${saved.id}?expectedVersion=${saved.version}`, 'DELETE');
  await f.request('/import', 'POST', { data: backup });
  assert.deepEqual(await f.request(`/views?projectId=${projectId}`), [saved]);
});

test('Jira priority saved views match complete imported categories, preserve live native behavior, and revalidate after edits', async t => {
  const f = await fixture(t);
  const origin = { id: '40350', key: 'LEGPRIORITY' };
  const [high, critical, minor, medium, deferred] = [
    { id: '71211', name: 'Engineering High' }, { id: '71212', name: 'Critical' }, { id: '71213', name: 'Minor' },
    { id: '71214', name: 'Normal' }, { id: '71215', name: 'Deferred backlog' },
  ];
  const projectId = await f.migrateJira('priority-source', [high, critical, minor, medium, deferred].map((priority, index) => ({
    ...origin, issueId: String(1150 + index), fields: { priority, summary: priority.name },
  })), 'TEAMPRIORITY');
  const imported = (await f.snapshot()).issues.filter(issue => issue.projectId === projectId);
  assert.deepEqual(Object.fromEntries(imported.map(issue => [issue.title, issue.priority])), {
    [high.name]: 'high', [critical.name]: 'high', [minor.name]: 'low', [medium.name]: 'medium', [deferred.name]: 'medium',
  });

  const jql = `project = ${origin.key} AND priority IN (${high.id}, ${critical.name})`;
  const review = await f.preview(jql, projectId);
  const expected = imported.filter(issue => issue.priority === 'high').map(issue => issue.id).sort();
  assert.deepEqual(review.filters.priorities, ['high']);
  assert.deepEqual(review.criteria.find(criterion => criterion.field === 'priority'), { field: 'priority', label: '우선순위 · 높음' });
  assert.deepEqual(review.issues.map(issue => issue.id).sort(), expected);
  const named = await f.preview(`priority IN ("${high.name}", ${critical.id})`, projectId);
  assert.deepEqual(named.filters, review.filters);
  assert.deepEqual(named.issues, review.issues);
  assert.deepEqual((await f.preview(`priority = ${minor.name}`, projectId)).filters.priorities, ['low']);
  for (const condition of [
    `priority = ${high.id}`, `priority IN (${high.id}, ${critical.id}) AND priority = ${critical.id}`,
    `priority = ${medium.name}`, `priority = ${deferred.id}`, 'priority = 71999', 'priority = high',
  ]) {
    const failure = await f.request<{ error: string }>(PREVIEW, 'POST', { projectId, jql: condition }, 400);
    assert.match(failure.error, /우선순위/u, condition);
  }

  const save = { projectId, jql, name: 'Jira priority categories', layout: 'board', acceptProjectOrder: false };
  const view = await f.request<SavedView>(IMPORT, 'POST', { ...save, revision: review.revision }, 201);
  assert.deepEqual(view.filters, review.filters);
  const native = await f.request<Issue>('/issues', 'POST', { projectId, title: 'New native high ticket', priority: 'high' }, 201);
  const afterCreate = await f.snapshot();
  const schema = afterCreate.issueSchemas?.find(value => value.projectId === projectId);
  assert.ok(schema);
  const matches = createIssueViewMatcher(view.filters, afterCreate, schema);
  assert.deepEqual(afterCreate.issues.filter(issue => issue.projectId === projectId && matches(issue)).map(issue => issue.id).sort(),
    [...expected, native.id].sort());

  const beforeEdit = await f.preview(jql, projectId);
  const localEdit = imported.find(issue => issue.title === minor.name);
  assert.ok(localEdit);
  const edited = await f.request<Issue>(`/issues/${localEdit.id}`, 'PATCH', { expectedVersion: localEdit.version, priority: 'high' });
  assert.ok(matches(edited));
  const blocked = await f.request<{ error: string }>(PREVIEW, 'POST', { projectId, jql }, 400);
  assert.match(blocked.error, /우선순위/u);
  const stale = await f.request<{ details: unknown }>(IMPORT, 'POST', { ...save, name: 'Stale priority preview', revision: beforeEdit.revision }, 409);
  assert.deepEqual(stale.details, STALE);
  assert.deepEqual(await f.request(`/views?projectId=${projectId}`), [view]);

  const backup = await f.request<WorkspaceSnapshot>('/export');
  assert.deepEqual(backup.savedViews, [view]);
  assert.doesNotMatch(JSON.stringify(backup.savedViews), /Engineering High|Critical|LEGPRIORITY/u);
  await f.request(`/views/${view.id}?expectedVersion=${view.version}`, 'DELETE');
  await f.request('/import', 'POST', { data: backup });
  assert.deepEqual(await f.request(`/views?projectId=${projectId}`), [view]);
});

test('Jira priority queries accept exact Teamspace values in a native project', async t => {
  const f = await fixture(t);
  const { id: projectId } = await f.request<Project>('/projects', 'POST', { name: 'Native priorities', key: 'LOCALPRIO' }, 201);
  const high = await f.request<Issue>('/issues', 'POST', { projectId, title: 'High local priority', priority: 'high' }, 201);
  await f.request<Issue>('/issues', 'POST', { projectId, title: 'Low local priority', priority: 'low' }, 201);
  const jql = 'project = LOCALPRIO AND priority IN (HIGH, "낮음") AND priority = "높음"';
  const review = await f.preview(jql, projectId);
  assert.deepEqual(review.filters.priorities, ['high']);
  assert.deepEqual(review.issues.map(issue => issue.id), [high.id]);
  const failure = await f.request<{ error: string }>(PREVIEW, 'POST', { projectId, jql: 'priority = Critical' }, 400);
  assert.match(failure.error, /우선순위/u);
});

test('Jira label-only priority joins a proven same-name option without establishing its numeric ID', async t => {
  const f = await fixture(t);
  const instanceKey = 'mixed-priority-source';
  const origin = { id: '40351', key: 'SOURCEPRIO' };
  const targetKey = 'MIXEDPRIO';
  const csv = [
    'Issue id,Issue key,Project id,Project key,Summary,Priority,Status,Issue Type,Created,Updated',
    `1900,${origin.key}-1900,${origin.id},${origin.key},CSV High,High,Open,Task,2020-01-01T00:00:00Z,2020-01-02T00:00:00Z`,
  ].join('\r\n');
  const projectId = await f.migrateJira(instanceKey, csv, targetKey);
  const [csvIssue] = (await f.snapshot()).issues.filter(issue => issue.projectId === projectId);
  assert.ok(csvIssue);
  assert.equal(csvIssue.priority, 'high');
  const nameQuery = `project = ${origin.key} AND priority = High`;
  assert.deepEqual((await f.preview(nameQuery, projectId)).issues.map(issue => issue.id), [csvIssue.id]);

  const append = (id: string, issueId: string) => f.migrateJira(instanceKey, [{
    ...origin, issueId, fields: { summary: `REST High ${id}`, priority: { id, name: 'High' } },
  }], targetKey, options => ({ appendTo: {
    projectId,
    statuses: Object.fromEntries(options.statuses.map(value => [value.id, csvIssue.status])),
    issueTypes: Object.fromEntries(options.issueTypes.map(value => [value.id, csvIssue.type])),
    fields: {},
  } }));
  await append('11', '1901');
  const both = await f.preview(nameQuery, projectId);
  assert.deepEqual(both.filters.priorities, ['high']);
  assert.deepEqual(both.issues.map(issue => issue.title).sort(), ['CSV High', 'REST High 11']);
  const numeric = await f.request<{ error: string }>(PREVIEW, 'POST', { projectId, jql: 'priority = 11' }, 400);
  assert.match(numeric.error, /우선순위/u);

  await append('12', '1902');
  const ambiguous = await f.request<{ error: string }>(PREVIEW, 'POST', { projectId, jql: nameQuery }, 400);
  assert.match(ambiguous.error, /우선순위/u);
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
