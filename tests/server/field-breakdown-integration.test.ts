import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../../server/app.js';
import type { ApiKeyCreated, CustomFieldValue, Issue, IssueBulkEditPreview, IssueFieldBreakdown, IssueFieldBreakdownPage, Project, ProjectIssueSchema, ProjectWorkflow, SavedView, WorkspaceSnapshot } from '../../shared/types.js';

const allFilters = { query: '', status: 'all', assigneeId: 'all', type: 'all' };
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'donefac-field-breakdown-'));
  const service = createApp({ dataDir: dir, outboundWorker: false }), server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async <T = Record<string, unknown>>(path: string, method = 'GET', body?: unknown, token?: string) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': 'user-yun', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as T };
  };
  const p = await call<Project>('/projects', 'POST', { key: 'FBD', name: '합성 필드 집계 프로젝트' }); assert.equal(p.status, 201);
  const schemaPath = `/projects/${p.data.id}/issue-schema`, initial = (await call<ProjectIssueSchema>(schemaPath)).data;
  const schema = await call<ProjectIssueSchema>(schemaPath, 'PATCH', { ...initial, expectedVersion: initial.version, fields: [
    { id: 'score', name: '합성 점수', kind: 'number', required: false, description: '', issueTypes: ['작업'], options: [], archived: false },
    { id: 'approved', name: '합성 승인', kind: 'checkbox', required: false, description: '', issueTypes: [], options: [], archived: false },
    { id: 'tags', name: '합성 분류', kind: 'multi_select', required: false, description: '', issueTypes: [], options: [{ id: 'red', name: '빨강', archived: false }, { id: 'blue', name: '파랑', archived: false }], archived: false },
    { id: 'owner', name: '합성 검토자', kind: 'user', required: false, description: '', issueTypes: [], options: [], archived: false },
  ] }); assert.equal(schema.status, 200, JSON.stringify(schema.data));
  const make = async (title: string, customFields: Record<string, CustomFieldValue> = {}, extras: Partial<Issue> = {}) => {
    const response = await call<Issue>('/issues', 'POST', { projectId: p.data.id, title, type: '작업', status: 'todo', assigneeId: 'user-yun', customFields, ...extras });
    assert.equal(response.status, 201, JSON.stringify(response.data)); return response.data;
  };
  const a = await make('검증 첫째', { score: 0, approved: false, tags: ['red', 'blue'], owner: 'user-yun' });
  const b = await make('검증 완료', { score: 10, approved: true, tags: ['blue'], owner: 'user-seo' }, { status: 'done' });
  const c = await make('검증 담당 다름', {}, { assigneeId: 'user-seo' });
  const d = await make('검증 버그', { approved: false }, { type: '버그' });
  const e = await make('검증 둘째', { score: 20, approved: false, tags: ['red'], owner: 'user-yun' });
  const unrelated = await make('다른 문구', { score: 5, approved: false });
  const approved = await make('검증 승인값 다름', { score: 30, approved: true });
  const view = await call<SavedView>('/views', 'POST', { projectId: p.data.id, name: '합성 복합 보기', layout: 'list', filters: {
    query: '검증', status: 'todo', assigneeId: 'user-yun', type: '작업', fieldFilter: { match: 'all', rules: [{ fieldId: 'approved', operator: 'equals', value: false }] },
  } }); assert.equal(view.status, 201, JSON.stringify(view.data));
  return { call, project: p.data, schemaPath, schema: schema.data, view: view.data, make, a, b, c, d, e, unrelated, approved, async close() { await new Promise<void>(resolve => server.close(() => resolve())); service.close(); rmSync(dir, { recursive: true, force: true }); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function breakdown(f: Fixture, fieldId: string, savedViewId: string | null = null, token?: string) {
  const response = await f.call<IssueFieldBreakdown>(`${token ? '/v1' : ''}/projects/${f.project.id}/field-breakdown`, 'POST', { fieldId, savedViewId }, token);
  assert.equal(response.status, 200, JSON.stringify(response.data)); return response.data;
}
async function drill(f: Fixture, summary: IssueFieldBreakdown, bucketId: string, offset = 0, token?: string) {
  return f.call<IssueFieldBreakdownPage>(`${token ? '/v1' : ''}/projects/${f.project.id}/field-breakdown/issues`, 'POST', { fieldId: summary.field.id, savedViewId: summary.savedView?.id ?? null, revision: summary.revision, bucketId, offset }, token);
}
const ids = (issues: { id: string }[]) => issues.map(issue => issue.id).sort();
function group(summary: IssueFieldBreakdown, kind: 'value' | 'missing' | 'not_applicable', label?: string) {
  const found = summary.groups.find(item => item.kind === kind && (label === undefined || item.label === label)); assert.ok(found, JSON.stringify(summary.groups)); return found;
}

test('field breakdown uses the complete persisted view population and exposes real numeric zero plus exact bucket drilldown', async () => {
  const f = await fixture();
  try {
    const before = (await f.call<WorkspaceSnapshot>('/workspace')).data, summary = await breakdown(f, 'score', f.view.id);
    assert.equal(summary.projectId, f.project.id); assert.deepEqual(summary.field, { id: 'score', name: '합성 점수', kind: 'number', archived: false });
    assert.deepEqual(summary.savedView, { id: f.view.id, name: f.view.name, version: f.view.version }); assert.ok(summary.revision); assert.ok(Number.isFinite(Date.parse(summary.generatedAt)));
    assert.equal(summary.totalIssues, 2); assert.equal(summary.applicableIssues, 2); assert.equal(summary.populatedIssues, 2); assert.equal(summary.missingIssues, 0); assert.equal(summary.notApplicableIssues, 0);
    assert.deepEqual(summary.numeric, { min: 0, max: 20, average: 10, sum: 20 });
    const zero = group(summary, 'value', '0'); assert.equal(zero.count, 1);
    const result = await drill(f, summary, zero.id); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.bucket.id, zero.id); assert.equal(result.data.total, 1); assert.equal(result.data.offset, 0);
    assert.deepEqual(result.data.issues, [{ id: f.a.id, key: f.a.key, title: f.a.title }]);
    assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).data, before);
  } finally { await f.close(); }
});

test('optional measures preserve exact counts and drilldown, bind saved-view scope, and invalidate stale bulk edits', async () => {
  const f = await fixture();
  try {
    const patch = async (issue: Issue, fields: Partial<Issue>) => {
      const response = await f.call<Issue>(`/issues/${issue.id}`, 'PATCH', { expectedVersion: issue.version, ...fields });
      assert.equal(response.status, 200, JSON.stringify(response.data));
      return response.data;
    };
    const first = await patch(f.a, { plannedEffortMinutes: 0, estimate: 1.25 });
    const second = await patch(f.e, { plannedEffortMinutes: 120, estimate: 3.75 });
    await patch(f.c, { plannedEffortMinutes: 600, estimate: 40 });
    const path = `/projects/${f.project.id}/field-breakdown`;
    const summary = async (query: object) => {
      const response = await f.call<IssueFieldBreakdown>(path, 'POST', query);
      assert.equal(response.status, 200, JSON.stringify(response.data));
      return response.data;
    };
    const scopes = { fieldId: 'tags', comparisonBy: 'assignee', savedViewId: f.view.id };
    const query = { ...scopes, measure: { kind: 'plannedEffortMinutes' } } as const;
    const plain = await summary(scopes);
    const report = await summary(query);
    assert.equal(plain.measure, undefined);
    assert.deepEqual(report.groups, plain.groups);
    assert.deepEqual(report.comparison, plain.comparison);
    assert.equal(report.totalIssues, 2);
    assert.notEqual(report.revision, plain.revision);
    const red = group(report, 'value', '빨강');
    const blue = group(report, 'value', '파랑');
    const [assignee] = report.comparison?.columns ?? [];
    assert.ok(assignee);
    assert.deepEqual(report.measure?.source, query.measure);
    assert.equal(report.measure?.label, '계획 작업 시간 (분)');
    assert.deepEqual(report.measure?.total, { valueCount: 2, sum: 120 });
    assert.deepEqual(report.measure?.rows[red.id], { valueCount: 2, sum: 120 });
    assert.deepEqual(report.measure?.rows[blue.id], { valueCount: 1, sum: 0 });
    assert.deepEqual(report.measure?.columns?.[assignee.id], { valueCount: 2, sum: 120 });
    assert.deepEqual(report.measure?.cells?.[blue.id]?.[assignee.id], { valueCount: 1, sum: 0 });

    const points = await summary({ ...scopes, measure: { kind: 'estimate' } });
    assert.equal(points.measure?.label, '스토리 포인트');
    assert.deepEqual(points.measure?.total, { valueCount: 2, sum: 5 });
    assert.deepEqual(points.measure?.cells?.[blue.id]?.[assignee.id], { valueCount: 1, sum: 1.25 });
    const numericRow = await summary({ fieldId: 'score', measure: { kind: 'custom', fieldId: 'score' } });
    assert.deepEqual(numericRow.numeric, { min: 0, max: 30, average: 13, sum: 65 });
    assert.equal(numericRow.measure?.label, '합성 점수');
    assert.deepEqual(numericRow.measure?.total, { valueCount: 5, sum: 65 });
    assert.deepEqual(numericRow.measure?.rows.missing, { valueCount: 0, sum: null });
    assert.deepEqual(numericRow.measure?.rows['not-applicable'], { valueCount: 0, sum: null });
    const missing = await f.call<IssueFieldBreakdownPage>(`${path}/issues`, 'POST', {
      fieldId: 'score', measure: { kind: 'custom', fieldId: 'score' }, revision: numericRow.revision, bucketId: 'not-applicable',
    });
    assert.equal(missing.status, 200, JSON.stringify(missing.data));
    assert.deepEqual(missing.data.issues.map(issue => [issue.id, issue.measureValue]), [[f.d.id, null]]);

    const selection = { ...query, revision: report.revision, bucketId: red.id, comparisonBucketId: assignee.id };
    const cell = await f.call<IssueFieldBreakdownPage>(`${path}/issues`, 'POST', selection);
    assert.equal(cell.status, 200, JSON.stringify(cell.data));
    assert.deepEqual(cell.data.issues.map(issue => [issue.id, issue.measureValue]), [[first.id, 0], [second.id, 120]]);
    assert.equal((await f.call(`${path}/issues`, 'POST', { ...selection, measure: undefined })).status, 409);
    assert.equal((await f.call(`${path}/issues`, 'POST', { ...selection, measure: { kind: 'estimate' } })).status, 409);
    const bulkPath = `/projects/${f.project.id}/issues/bulk`;
    const reviewed = await f.call<IssueBulkEditPreview>(`${bulkPath}-preview`, 'POST', {
      issues: [{ id: second.id, expectedVersion: second.version }], changes: { priority: 'urgent' }, fieldBreakdown: selection,
    });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
    assert.ok(reviewed.data.previewId);
    await patch(first, { plannedEffortMinutes: 15 });
    assert.equal((await f.call(`${path}/issues`, 'POST', selection)).status, 409);
    const stale = await f.call<{ details: { reason: string } }>(`${bulkPath}-apply`, 'POST', { previewId: reviewed.data.previewId });
    assert.equal(stale.status, 409, JSON.stringify(stale.data));
    assert.equal(stale.data.details.reason, 'field_breakdown_stale');
    const refreshed = await summary(query);
    assert.deepEqual(refreshed.groups, report.groups);
    assert.deepEqual(refreshed.comparison, report.comparison);
    assert.deepEqual(refreshed.measure?.total, { valueCount: 2, sum: 135 });
    assert.equal((await f.call<WorkspaceSnapshot>('/workspace')).data.issues.find(issue => issue.id === second.id)?.priority, second.priority);

    for (const measure of [{ kind: 'unknown' }, { kind: 'custom' }, { kind: 'custom', fieldId: 'approved' }, { kind: 'estimate', fieldId: 'score' }, []]) {
      assert.equal((await f.call(path, 'POST', { ...scopes, measure })).status, 400, JSON.stringify(measure));
    }
    assert.equal((await f.call(path, 'POST', { ...scopes, measure: { kind: 'custom', fieldId: 'not-in-project' } })).status, 404);
    const outsideSchemaPath = '/projects/project-team/issue-schema';
    const { data: outsideSchema } = await f.call<ProjectIssueSchema>(outsideSchemaPath);
    const foreignField = { ...f.schema.fields.find(field => field.id === 'score')!, id: 'foreign-score' };
    const definedOutside = await f.call(outsideSchemaPath, 'PATCH', {
      ...outsideSchema, expectedVersion: outsideSchema.version, fields: [...outsideSchema.fields, foreignField],
    });
    assert.equal(definedOutside.status, 200, JSON.stringify(definedOutside.data));
    assert.equal((await f.call(path, 'POST', { ...scopes, measure: { kind: 'custom', fieldId: foreignField.id } })).status, 404);
  } finally { await f.close(); }
});

test('missing and not-applicable partitions are exclusive; false stays present and multi-select value buckets overlap', async () => {
  const f = await fixture();
  try {
    const number = await breakdown(f, 'score'); assert.equal(number.totalIssues, 7); assert.equal(number.applicableIssues, 6); assert.equal(number.populatedIssues, 5); assert.equal(number.missingIssues, 1); assert.equal(number.notApplicableIssues, 1);
    assert.deepEqual(number.numeric, { min: 0, max: 30, average: 13, sum: 65 });
    const missing = await drill(f, number, group(number, 'missing').id), notApplicable = await drill(f, number, group(number, 'not_applicable').id);
    assert.equal(missing.status, 200); assert.deepEqual(ids(missing.data.issues), [f.c.id]); assert.equal(notApplicable.status, 200); assert.deepEqual(ids(notApplicable.data.issues), [f.d.id]);
    const checkbox = await breakdown(f, 'approved'); assert.equal(checkbox.populatedIssues, 6); assert.equal(checkbox.missingIssues, 1); assert.equal(checkbox.notApplicableIssues, 0); assert.equal(checkbox.numeric, null);
    assert.deepEqual(checkbox.groups.filter(item => item.kind === 'value').map(item => item.count).sort(), [2, 4]);
    const falseGroup = checkbox.groups.find(item => item.kind === 'value' && item.count === 4)!;
    const falseIssues = await drill(f, checkbox, falseGroup.id); assert.equal(falseIssues.status, 200); assert.deepEqual(ids(falseIssues.data.issues), ids([f.a, f.d, f.e, f.unrelated]));
    const multiple = await breakdown(f, 'tags'); assert.equal(multiple.populatedIssues, 3); assert.equal(multiple.missingIssues, 4); assert.equal(multiple.numeric, null);
    const red = group(multiple, 'value', '빨강'), blue = group(multiple, 'value', '파랑'); assert.equal(red.count, 2); assert.equal(blue.count, 2); assert.ok(red.count + blue.count > multiple.populatedIssues);
    const redIssues = await drill(f, multiple, red.id), blueIssues = await drill(f, multiple, blue.id); assert.equal(redIssues.status, 200); assert.equal(blueIssues.status, 200);
    assert.deepEqual(ids(redIssues.data.issues), ids([f.a, f.e])); assert.deepEqual(ids(blueIssues.data.issues), ids([f.a, f.b]));
    const archived = await f.call(f.schemaPath, 'PATCH', { ...f.schema, expectedVersion: f.schema.version, fields: f.schema.fields.map(field => field.id === 'tags' ? { ...field, archived: true, options: field.options.map(option => option.id === 'red' ? { ...option, name: '이전 빨강', archived: true } : option) } : field) });
    assert.equal(archived.status, 200, JSON.stringify(archived.data));
    const historical = await breakdown(f, 'tags'); assert.equal(historical.field.archived, true); assert.equal(group(historical, 'value', '이전 빨강').count, 2);
    const historicalIssues = await drill(f, historical, group(historical, 'value', '이전 빨강').id); assert.equal(historicalIssues.status, 200); assert.deepEqual(ids(historicalIssues.data.issues), ids([f.a, f.e]));
  } finally { await f.close(); }
});

test('drilldown rejects revisions made stale by issue, saved view, field and user-label changes and validates project context', async () => {
  const f = await fixture();
  try {
    const initial = await breakdown(f, 'score', f.view.id);
    assert.equal((await f.call(`/issues/${f.a.id}`, 'PATCH', { expectedVersion: f.a.version, title: '검증 이후 수정한 제목' })).status, 200);
    assert.equal((await drill(f, initial, group(initial, 'value', '0').id)).status, 409);
    const beforeView = await breakdown(f, 'score', f.view.id);
    assert.equal((await f.call(`/views/${f.view.id}`, 'PATCH', { expectedVersion: f.view.version, name: '다른 이름으로 저장한 보기' })).status, 200);
    assert.equal((await drill(f, beforeView, group(beforeView, 'value', '0').id)).status, 409);
    const beforeSchema = await breakdown(f, 'score', f.view.id);
    assert.equal((await f.call(f.schemaPath, 'PATCH', { ...f.schema, expectedVersion: f.schema.version, fields: f.schema.fields.map(field => field.id === 'score' ? { ...field, name: '바뀐 점수 이름' } : field) })).status, 200);
    assert.equal((await drill(f, beforeSchema, group(beforeSchema, 'value', '0').id)).status, 409);
    const beforeUser = await breakdown(f, 'owner');
    assert.equal((await f.call('/users/user-yun', 'PATCH', { name: '합성 검토자 이름 변경' })).status, 200);
    assert.equal((await drill(f, beforeUser, group(beforeUser, 'value').id)).status, 409);
    const foreign = await f.call<SavedView>('/views', 'POST', { projectId: 'project-team', name: '다른 프로젝트 보기', layout: 'list', filters: allFilters }); assert.equal(foreign.status, 201);
    assert.equal((await f.call(`/projects/${f.project.id}/field-breakdown`, 'POST', { fieldId: 'score', savedViewId: foreign.data.id })).status, 404);
    const current = await breakdown(f, 'score');
    assert.equal((await drill(f, current, group(current, 'value', '0').id, -1)).status, 400);
    assert.equal((await drill(f, current, 'unknown-bucket')).status, 404);
    assert.equal((await f.call(`/projects/${f.project.id}/field-breakdown`, 'POST', { fieldId: 'unknown-field' })).status, 404);
  } finally { await f.close(); }
});

test('read API keys can inspect both breakdown routes only within scope, and bucket issue pages have a stable fifty-row limit', async () => {
  const f = await fixture();
  try {
    const added: Issue[] = []; for (let index = 0; index < 51; index++) added.push(await f.make(`합성 페이지 업무 ${index + 1}`, { approved: false }));
    const key = await f.call<ApiKeyCreated>('/api-keys', 'POST', { name: '합성 집계 읽기 키', access: 'read', projectIds: [f.project.id], expiresAt: null }); assert.equal(key.status, 201);
    const before = (await f.call<WorkspaceSnapshot>('/workspace')).data, summary = await breakdown(f, 'approved', null, key.data.token);
    const bucket = summary.groups.find(item => item.kind === 'value' && item.count === 55); assert.ok(bucket);
    const first = await drill(f, summary, bucket.id, 0, key.data.token), second = await drill(f, summary, bucket.id, 50, key.data.token);
    assert.equal(first.status, 200, JSON.stringify(first.data)); assert.equal(second.status, 200, JSON.stringify(second.data));
    assert.equal(first.data.total, 55); assert.equal(second.data.total, 55); assert.equal(first.data.issues.length, 50); assert.equal(second.data.issues.length, 5); assert.equal(second.data.offset, 50);
    assert.deepEqual(new Set([...first.data.issues, ...second.data.issues].map(issue => issue.id)), new Set(ids([f.a, f.d, f.e, f.unrelated, ...added])));
    const beyond = await drill(f, summary, bucket.id, 100, key.data.token); assert.equal(beyond.status, 200); assert.equal(beyond.data.total, 55); assert.equal(beyond.data.offset, 100); assert.deepEqual(beyond.data.issues, []);
    for (const suffix of ['', '/issues']) assert.equal((await f.call(`/v1/projects/project-team/field-breakdown${suffix}`, 'POST', { fieldId: 'approved', revision: summary.revision, bucketId: bucket.id }, key.data.token)).status, 403);
    assert.equal((await f.call('/v1/issues', 'POST', { projectId: f.project.id, title: '읽기 키로 생성 불가' }, key.data.token)).status, 403);
    assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).data, before);
  } finally { await f.close(); }
});

test('status by assignee uses a saved view and project workflow even with no custom fields', async () => {
  const f = await fixture();
  try {
    const project = await f.call<Project>('/projects', 'POST', { key: 'MTRX', name: '합성 기본 필드 집계 프로젝트' });
    assert.equal(project.status, 201, JSON.stringify(project.data));
    const projectId = project.data.id;
    assert.deepEqual((await f.call<ProjectIssueSchema>(`/projects/${projectId}/issue-schema`)).data.fields, []);
    const statusId = 'matrix_ready';
    const label = '이 프로젝트 전용 검토';
    async function addStatus(owner: string, statusLabel: string) {
      const path = `/projects/${owner}/workflow`;
      const current = (await f.call<ProjectWorkflow>(path)).data;
      const result = await f.call<ProjectWorkflow>(path, 'PATCH', { ...current, expectedVersion: current.version,
        statuses: [...current.statuses, { id: statusId, label: statusLabel, category: 'review', color: '#5778A2' }],
      });
      assert.equal(result.status, 200, JSON.stringify(result.data));
      return result.data;
    }
    const workflow = await addStatus(projectId, label);
    await addStatus(f.project.id, '다른 프로젝트 전용 검토');
    const first = await f.make('분류 대상 첫째', {}, { projectId, status: statusId });
    const unassigned = await f.make('분류 대상 미정', {}, { projectId, status: statusId, assigneeId: null });
    const done = await f.make('분류 대상 완료', {}, { projectId, status: 'done' });
    await f.make('다른 조건에서만 보임', {}, { projectId, status: statusId });
    await f.make('분류 대상 다른 프로젝트', {}, { status: statusId });
    const selected = await f.call<SavedView>('/views', 'POST', { projectId, name: '분류 대상을 골라 쓰는 보드', layout: 'board',
      filters: { ...allFilters, query: '분류 대상' },
    });
    assert.equal(selected.status, 201, JSON.stringify(selected.data));
    const workspace = (await f.call<WorkspaceSnapshot>('/workspace')).data;
    const person = workspace.users.find(user => user.id === first.assigneeId);
    const doneLabel = workflow.statuses.find(state => state.id === 'done')?.label;
    assert.ok(person && doneLabel);
    const view = selected.data;
    const key = await f.call<ApiKeyCreated>('/api-keys', 'POST', { name: '합성 기본 필드 집계 읽기 키', access: 'read', projectIds: [projectId], expiresAt: null });
    assert.equal(key.status, 201, JSON.stringify(key.data));
    const token = key.data.token;
    const path = `/v1/projects/${projectId}/field-breakdown`;
    const query = { groupBy: 'status', comparisonBy: 'assignee', savedViewId: view.id };
    const read = async () => {
      const result = await f.call<IssueFieldBreakdown>(path, 'POST', query, token);
      assert.equal(result.status, 200, JSON.stringify(result.data));
      return result.data;
    };
    const summary = await read();
    assert.deepEqual(summary.savedView, { id: view.id, name: view.name, version: view.version });
    assert.equal(summary.groupBy, 'status');
    assert.equal(summary.field.id, 'builtin:status');
    assert.equal(summary.totalIssues, 3);
    assert.equal(summary.numeric, null);
    const review = group(summary, 'value', label);
    const complete = group(summary, 'value', doneLabel);
    assert.deepEqual(summary.groups.filter(row => row.count > 0).map(row => row.label).sort(), [label, doneLabel].sort());
    assert.equal(review.count, 2);
    assert.equal(complete.count, 1);
    assert.ok(summary.comparison);
    assert.equal(summary.comparison.by, 'assignee');
    const assignedColumn = summary.comparison.columns.find(column => column.label === person.name);
    const emptyColumn = summary.comparison.columns.find(column => column.label === '미지정');
    assert.ok(assignedColumn && emptyColumn);
    assert.deepEqual([assignedColumn.count, emptyColumn.count], [2, 1]);
    assert.deepEqual(summary.comparison.counts, {
      [review.id]: { [assignedColumn.id]: 1, [emptyColumn.id]: 1 },
      [complete.id]: { [assignedColumn.id]: 1 },
    });

    const cell = { ...query, revision: summary.revision, bucketId: review.id, comparisonBucketId: emptyColumn.id };
    const readCell = (body: Record<string, unknown>) => f.call<IssueFieldBreakdownPage>(`${path}/issues`, 'POST', body, token);
    const empty = await readCell({ ...cell, bucketId: complete.id });
    assert.equal(empty.status, 200, JSON.stringify(empty.data));
    assert.deepEqual([empty.data.total, empty.data.issues], [0, []]);
    const reviewed = await readCell(cell);
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
    assert.deepEqual(reviewed.data.bucket, review);
    assert.deepEqual(reviewed.data.comparisonBucket, emptyColumn);
    assert.deepEqual(ids(reviewed.data.issues), [unassigned.id]);
    const entire = await readCell({ ...cell, comparisonBucketId: undefined });
    assert.equal(entire.status, 200, JSON.stringify(entire.data));
    assert.deepEqual(ids(entire.data.issues), ids([first, unassigned]));
    assert.equal(entire.data.comparisonBucket, undefined);
    assert.equal((await readCell({ ...cell, comparisonBucketId: 'nonexistent' })).status, 404);
    assert.equal((await readCell({ ...cell, comparisonBy: 'priority' })).status, 409);
    assert.equal((await f.call(`/v1/projects/${f.project.id}/field-breakdown`, 'POST', query, token)).status, 403);
    for (const invalid of [{ ...query, fieldId: 'score' }, { ...query, comparisonBy: 'status' }, { ...query, groupBy: 'other' }]) {
      assert.equal((await f.call(path, 'POST', invalid, token)).status, 400);
    }

    const renamed = '바뀐 검토 제목';
    const changed = await f.call(`/projects/${projectId}/workflow`, 'PATCH', { ...workflow, expectedVersion: workflow.version,
      statuses: workflow.statuses.map(state => state.id === statusId ? { ...state, label: renamed } : state),
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.data));
    const after = (await f.call<WorkspaceSnapshot>('/workspace')).data;
    assert.deepEqual(after.issues.filter(issue => issue.projectId === projectId), workspace.issues.filter(issue => issue.projectId === projectId));
    assert.equal((await readCell(cell)).status, 409);
    const refreshed = await read();
    assert.notEqual(refreshed.revision, summary.revision);
    assert.equal(group(refreshed, 'value', renamed).id, review.id);
    const updated = await readCell({ ...cell, revision: refreshed.revision });
    assert.equal(updated.status, 200, JSON.stringify(updated.data));
    assert.deepEqual(ids(updated.data.issues), [unassigned.id]);
    const doneCell = await readCell({ ...cell, revision: refreshed.revision, bucketId: complete.id, comparisonBucketId: assignedColumn.id });
    assert.deepEqual(ids(doneCell.data.issues), [done.id]);
  } finally { await f.close(); }
});

test('reporter cross-tabs support exact rows and columns, scoped saved views and stale bulk edit guards', async () => {
  const f = await fixture();
  try {
    const { id: projectId } = f.project;
    const prefix = '요청자 집계 대상';
    const named = await f.make(`${prefix} 기록됨`, {}, { reporterId: 'user-seo' });
    const blank = await f.make(`${prefix} 미지정`, {}, { reporterId: null });
    const historical = await f.make(`${prefix} 예전 업무`);
    await f.make('저장 보기 범위 밖', {}, { reporterId: 'user-seo' });
    const exported = await f.call<{ issues: Issue[] }>('/export');
    assert.equal(exported.status, 200);
    delete exported.data.issues.find(issue => issue.id === historical.id)!.reporterId;
    const imported = await f.call('/import', 'POST', { data: exported.data });
    assert.equal(imported.status, 200, JSON.stringify(imported.data));
    const { issues, users } = (await f.call<WorkspaceSnapshot>('/workspace')).data;
    const unchanged = issues.find(issue => issue.id === blank.id)!;
    const legacy = issues.find(issue => issue.id === historical.id)!;
    const reporter = users.find(user => user.id === named.reporterId)!;

    const filters = { ...allFilters, query: prefix };
    const view = await f.call<SavedView>('/views', 'POST', { projectId, name: '요청 집계 범위', layout: 'board', filters });
    const onlyLegacy = await f.call<SavedView>('/views', 'POST', { projectId, name: '기록 없는 요청', layout: 'list',
      filters: { ...filters, reporter: { kind: 'unknown' } },
    });
    const key = await f.call<ApiKeyCreated>('/api-keys', 'POST', { name: '요청자 집계 키', access: 'read', projectIds: [projectId], expiresAt: null });
    assert.equal(view.status, 201, JSON.stringify(view.data));
    assert.equal(onlyLegacy.status, 201, JSON.stringify(onlyLegacy.data));
    assert.equal(key.status, 201, JSON.stringify(key.data));
    const token = key.data.token;
    const path = `/v1/projects/${projectId}/field-breakdown`;
    const query = { groupBy: 'reporter', comparisonBy: 'assignee', savedViewId: view.data.id };
    const read = async (state: Record<string, unknown>) => {
      const response = await f.call<IssueFieldBreakdown>(path, 'POST', state, token);
      assert.equal(response.status, 200, JSON.stringify(response.data));
      return response.data;
    };
    const readCell = (state: Record<string, unknown>) => f.call<IssueFieldBreakdownPage>(`${path}/issues`, 'POST', state, token);
    const report = await read(query);
    assert.equal(report.totalIssues, 3);
    assert.deepEqual(report.field, { id: 'builtin:reporter', name: '요청자', kind: 'user', archived: false });
    assert.ok(report.comparison && report.comparison.columns.length === 1);
    const comparisonBucketId = report.comparison.columns[0].id;
    const namedBucket = group(report, 'value', reporter.name);
    const cell = { ...query, revision: report.revision, bucketId: 'missing', comparisonBucketId };
    for (const [bucketId, issue] of [[namedBucket.id, named], ['missing', blank], ['unknown', historical]] as const) {
      const response = await readCell({ ...cell, bucketId });
      assert.equal(response.status, 200, JSON.stringify(response.data));
      assert.deepEqual(ids(response.data.issues), [issue.id]);
      assert.equal(report.comparison.counts[bucketId]?.[comparisonBucketId], 1);
    }
    const reverse = await read({ groupBy: 'status', comparisonBy: 'reporter', savedViewId: onlyLegacy.data.id });
    assert.equal(reverse.totalIssues, 1);
    assert.deepEqual(reverse.comparison?.columns, [{ id: 'unknown', label: '기록 없음', count: 1 }]);
    assert.equal((await f.call('/v1/projects/project-team/field-breakdown', 'POST', query, token)).status, 403);

    const bulkPath = `/projects/${projectId}/issues/bulk`;
    const reviewed = await f.call<IssueBulkEditPreview>(`${bulkPath}-preview`, 'POST', {
      issues: [{ id: unchanged.id, expectedVersion: unchanged.version }], changes: { priority: 'urgent' }, fieldBreakdown: cell,
    });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
    assert.ok(reviewed.data.previewId);
    const updated = await f.call<Issue>(`/issues/${legacy.id}`, 'PATCH', { expectedVersion: legacy.version, reporterId: reporter.id });
    assert.equal(updated.status, 200, JSON.stringify(updated.data));
    assert.equal((await readCell(cell)).status, 409);
    const rejected = await f.call<{ details: { reason: string } }>(`${bulkPath}-apply`, 'POST', { previewId: reviewed.data.previewId });
    assert.equal(rejected.status, 409, JSON.stringify(rejected.data));
    assert.equal(rejected.data.details.reason, 'field_breakdown_stale');
    assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).data.issues.find(issue => issue.id === unchanged.id), unchanged);
    assert.equal((await read({ groupBy: 'status', comparisonBy: 'reporter', savedViewId: onlyLegacy.data.id })).totalIssues, 0);
  } finally { await f.close(); }
});

test('custom field by status keeps overlapping memberships and priority by type uses native labels', async () => {
  const f = await fixture();
  try {
    const path = `/projects/${f.project.id}/field-breakdown`;
    const legacy = await breakdown(f, 'tags');
    assert.equal(legacy.groupBy, undefined);
    assert.equal(legacy.comparison, undefined);
    const query = { fieldId: 'tags', comparisonBy: 'status' };
    const { status, data: matrix } = await f.call<IssueFieldBreakdown>(path, 'POST', query);
    assert.equal(status, 200, JSON.stringify(matrix));
    assert.deepEqual(matrix.field, legacy.field);
    assert.deepEqual(matrix.groups, legacy.groups);
    assert.equal(matrix.totalIssues, 7);
    assert.ok(matrix.comparison);
    const [todo, done] = [6, 1].map(count => matrix.comparison!.columns.find(column => column.count === count));
    assert.ok(todo && done);
    const red = group(matrix, 'value', '빨강');
    const blue = group(matrix, 'value', '파랑');
    const missing = group(matrix, 'missing');
    assert.equal(matrix.comparison.by, 'status');
    assert.deepEqual(matrix.comparison.counts[red.id], { [todo.id]: 2 });
    assert.deepEqual(matrix.comparison.counts[blue.id], { [todo.id]: 1, [done.id]: 1 });
    assert.deepEqual(matrix.comparison.counts[missing.id], { [todo.id]: 4 });
    const readCell = (bucketId: string, comparisonBucketId: string) => f.call<IssueFieldBreakdownPage>(`${path}/issues`, 'POST', {
      ...query, revision: matrix.revision, bucketId, comparisonBucketId,
    });
    for (const [bucket, column, expected] of [[red, todo, [f.a, f.e]], [blue, todo, [f.a]], [blue, done, [f.b]]] as const) {
      const cell = await readCell(bucket.id, column.id);
      assert.equal(cell.status, 200, JSON.stringify(cell.data));
      assert.deepEqual(ids(cell.data.issues), expected.map(issue => issue.id).sort());
    }

    const type = { id: 'matrix_task', name: '합성 전용 작업', color: '#597DAA', archived: false };
    const schema = await f.call<ProjectIssueSchema>(f.schemaPath, 'PATCH', { ...f.schema, expectedVersion: f.schema.version,
      issueTypes: [...f.schema.issueTypes, type],
    });
    assert.equal(schema.status, 200, JSON.stringify(schema.data));
    const urgent = await f.make('별도 우선순위 집계 업무', {}, { type: type.id, priority: 'urgent' });
    const nativeQuery = { groupBy: 'priority', comparisonBy: 'type' };
    const native = await f.call<IssueFieldBreakdown>(path, 'POST', nativeQuery);
    assert.equal(native.status, 200, JSON.stringify(native.data));
    const priority = group(native.data, 'value', '긴급');
    const kind = native.data.comparison?.columns.find(column => column.label === type.name);
    assert.ok(kind);
    assert.equal(native.data.comparison?.counts[priority.id]?.[kind.id], 1);
    const pair = await f.call<IssueFieldBreakdownPage>(`${path}/issues`, 'POST', {
      ...nativeQuery, revision: native.data.revision, bucketId: priority.id, comparisonBucketId: kind.id,
    });
    assert.equal(pair.status, 200, JSON.stringify(pair.data));
    assert.deepEqual(ids(pair.data.issues), [urgent.id]);
  } finally { await f.close(); }
});

test('custom comparison columns keep exact scoped cell membership for pages and bulk edits', async () => {
  const f = await fixture();
  try {
    const { id: projectId } = f.project;
    const path = `/projects/${projectId}/field-breakdown`;
    const cross = { fieldId: 'tags', comparisonFieldId: 'score' };
    const { status: crossStatus, data: crossReport } = await f.call<IssueFieldBreakdown>(path, 'POST', cross);
    assert.equal(crossStatus, 200, JSON.stringify(crossReport));
    const zero = crossReport.comparison?.columns.find(column => column.label === '0');
    assert.ok(zero);
    assert.equal(crossReport.comparison?.columns.find(column => column.id === 'missing')?.count, 1);
    assert.equal(crossReport.comparison?.columns.find(column => column.id === 'not-applicable')?.count, 1);
    const redRow = group(crossReport, 'value', '빨강');
    const zeroCell = await f.call<IssueFieldBreakdownPage>(`${path}/issues`, 'POST', {
      ...cross, revision: crossReport.revision, bucketId: redRow.id, comparisonBucketId: zero.id,
    });
    assert.equal(zeroCell.status, 200, JSON.stringify(zeroCell.data));
    assert.deepEqual(ids(zeroCell.data.issues), [f.a.id]);

    const added: Issue[] = [];
    for (let index = 1; index <= 51; index++) {
      added.push(await f.make(`검증 비교 페이지 ${index}`, { approved: false, tags: ['red'] }));
    }
    const foreign = await f.make('검증 다른 프로젝트 업무', {}, { projectId: 'project-team' });
    const key = await f.call<ApiKeyCreated>('/api-keys', 'POST', {
      name: '합성 비교 읽기 키', access: 'read', projectIds: [projectId], expiresAt: null,
    });
    assert.equal(key.status, 201, JSON.stringify(key.data));
    const token = key.data.token;
    const query = { groupBy: 'status', comparisonFieldId: 'tags', savedViewId: f.view.id };
    const read = async () => {
      const result = await f.call<IssueFieldBreakdown>(`/v1${path}`, 'POST', query, token);
      assert.equal(result.status, 200, JSON.stringify(result.data));
      return result.data;
    };
    const matrix = await read();
    assert.equal(matrix.totalIssues, 53);
    assert.deepEqual(matrix.comparison?.field, { id: 'tags', kind: 'multi_select', name: '합성 분류', archived: false });
    const red = matrix.comparison?.columns.find(column => column.label === '빨강');
    const blue = matrix.comparison?.columns.find(column => column.label === '파랑');
    const row = matrix.groups.find(bucket => bucket.count === matrix.totalIssues);
    assert.ok(red && blue && row);
    assert.deepEqual([red.count, blue.count], [53, 1]);
    assert.deepEqual(matrix.comparison?.counts[row.id], { [red.id]: 53, [blue.id]: 1 });

    const cell = { ...query, revision: matrix.revision, bucketId: row.id, comparisonBucketId: red.id };
    const readCell = (offset: number) => f.call<IssueFieldBreakdownPage>(`/v1${path}/issues`, 'POST', {
      ...cell, offset, includeEditTargets: true,
    }, token);
    const [first, next] = await Promise.all([readCell(0), readCell(50)]);
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(next.status, 200, JSON.stringify(next.data));
    assert.equal(first.data.total, 53);
    assert.equal(next.data.total, 53);
    assert.deepEqual([first.data.issues.length, next.data.issues.length], [50, 3]);
    assert.deepEqual(ids([...first.data.issues, ...next.data.issues]), ids([f.a, f.e, ...added]));
    assert.deepEqual(ids(next.data.editTargets ?? []), ids(next.data.issues));
    for (const suffix of ['', '/issues']) {
      assert.equal((await f.call(`/v1/projects/project-team/field-breakdown${suffix}`, 'POST', cell, token)).status, 403);
    }
    assert.equal((await f.call(path, 'POST', { ...query, comparisonBy: 'assignee' })).status, 400);
    assert.equal((await f.call(path, 'POST', { ...cross, comparisonFieldId: 'tags' })).status, 400);
    assert.equal((await f.call(path, 'POST', { ...query, comparisonFieldId: 'absent' })).status, 404);
    assert.equal((await f.call(`${path}/issues`, 'POST', { ...cell, comparisonFieldId: 'absent' })).status, 404);

    const bulkPath = `/projects/${projectId}/issues/bulk`;
    const review = (issue: Issue, fieldBreakdown = cell) => f.call<IssueBulkEditPreview>(`${bulkPath}-preview`, 'POST', {
      issues: [{ id: issue.id, expectedVersion: issue.version }], changes: { priority: 'urgent' }, fieldBreakdown,
    });
    assert.equal((await review(f.b)).status, 409);
    assert.equal((await review(foreign)).status, 409);
    const reviewed = await review(f.e);
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
    assert.ok(reviewed.data.previewId);
    const changed = await f.call<Issue>(`/issues/${f.a.id}`, 'PATCH', { expectedVersion: f.a.version, customFields: { ...f.a.customFields, tags: ['blue'] } });
    assert.equal(changed.status, 200, JSON.stringify(changed.data));
    assert.equal((await readCell(0)).status, 409);
    const stale = await f.call<{ details: { reason: string } }>(`${bulkPath}-apply`, 'POST', { previewId: reviewed.data.previewId });
    assert.equal(stale.status, 409, JSON.stringify(stale.data));
    assert.equal(stale.data.details.reason, 'field_breakdown_stale');
    const current = (await f.call<WorkspaceSnapshot>('/workspace')).data.issues;
    assert.deepEqual(current.find(issue => issue.id === f.e.id), f.e);
    assert.deepEqual(current.find(issue => issue.id === foreign.id), foreign);

    const refreshed = await read();
    const refreshedCell = { ...cell, revision: refreshed.revision };
    const fresh = await review(f.e, refreshedCell);
    assert.equal(fresh.status, 200, JSON.stringify(fresh.data));
    assert.ok(fresh.data.previewId);
    const applied = await f.call(`${bulkPath}-apply`, 'POST', { previewId: fresh.data.previewId });
    assert.equal(applied.status, 200, JSON.stringify(applied.data));
    assert.equal((await f.call<WorkspaceSnapshot>('/workspace')).data.issues.find(issue => issue.id === f.e.id)?.priority, 'urgent');
  } finally { await f.close(); }
});
