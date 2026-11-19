import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../../server/app.js';
import type { ApiKeyCreated, CustomFieldValue, Issue, IssueFieldBreakdown, IssueFieldBreakdownPage, Project, ProjectIssueSchema, SavedView, WorkspaceSnapshot } from '../../shared/types.js';

const allFilters = { query: '', status: 'all', assigneeId: 'all', type: 'all' };
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'teamspace-field-breakdown-'));
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
