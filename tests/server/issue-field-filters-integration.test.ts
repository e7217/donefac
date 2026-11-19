import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../../server/app.js';
import type { ApiKeyCreated, CustomFieldDefinition, CustomFieldValue, Issue, IssueFieldFilter, IssueFieldRule, Project, ProjectIssueSchema, SavedView, WorkspaceSnapshot } from '../../shared/types.js';

type Backup = WorkspaceSnapshot & { schemaVersion: number };
function field(id: string, kind: CustomFieldDefinition['kind'], options: string[] = [], issueTypes: string[] = []): CustomFieldDefinition {
  return { id, name: `합성 ${id}`, kind, description: '', required: false, issueTypes, archived: false, options: options.map(id => ({ id, name: `선택 ${id}`, archived: false })) };
}
function filter(...rules: IssueFieldRule[]): IssueFieldFilter { return { match: 'all', rules }; }
const basicFilters = { query: '', status: 'all', assigneeId: 'all', type: 'all' };
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'teamspace-field-filters-'));
  const service = createApp({ dataDir: dir, outboundWorker: false }), server = service.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async <T = Record<string, unknown>>(path: string, method = 'GET', body?: unknown, token?: string) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': 'user-yun', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as T };
  };
  const created = await call<Project>('/projects', 'POST', { key: 'CFT', name: '합성 사용자 필드 조회 프로젝트' }); assert.equal(created.status, 201);
  const schemaPath = `/projects/${created.data.id}/issue-schema`, initial = (await call<ProjectIssueSchema>(schemaPath)).data;
  const configured = await call<ProjectIssueSchema>(schemaPath, 'PATCH', { ...initial, expectedVersion: initial.version, fields: [
    field('score', 'number'), field('approved', 'checkbox'), field('when', 'date'), field('notes', 'text'), field('reviewer', 'user'),
    field('severity', 'select', ['major', 'minor']), field('tags', 'multi_select', ['red', 'blue']), field('url', 'url'),
    field('future', 'select', ['unused', 'other']), field('scoped', 'text', [], ['버그']),
  ] }); assert.equal(configured.status, 200, JSON.stringify(configured.data));
  const make = async (title: string, customFields: Record<string, CustomFieldValue> = {}, type = '작업') => {
    const response = await call<Issue>('/issues', 'POST', { projectId: created.data.id, title, type, customFields });
    assert.equal(response.status, 201, JSON.stringify(response.data)); return response.data;
  };
  const a = await make('합성 값 0과 false', { score: 0, approved: false, when: '2026-11-19', notes: '검증 회귀', reviewer: 'user-yun', severity: 'major', tags: ['red', 'blue'], url: 'https://example.test/A' });
  const b = await make('합성 값 5와 true', { score: 5, approved: true, when: '2026-12-01', notes: '성능 개선', reviewer: 'user-seo', severity: 'minor', tags: ['blue'], url: 'https://example.test/B' });
  const c = await make('합성 값 미지정'), d = await make('합성 버그 유형', {}, '버그');
  return { call, project: created.data, schemaPath, schema: configured.data, a, b, c, d, async close() { await new Promise<void>(resolve => server.close(() => resolve())); service.close(); rmSync(dir, { recursive: true, force: true }); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function query(f: Fixture, fieldFilter: IssueFieldFilter, token?: string) {
  const response = await f.call<Issue[]>(`${token ? '/v1' : ''}/issues/query`, 'POST', { projectId: f.project.id, fieldFilter }, token);
  assert.equal(response.status, 200, JSON.stringify(response.data)); return response.data.map(issue => issue.id).sort();
}
async function save(f: Fixture, name: string, fieldFilter: IssueFieldFilter) {
  const response = await f.call<SavedView>('/views', 'POST', { projectId: f.project.id, name, layout: 'list', filters: { ...basicFilters, fieldFilter } });
  assert.equal(response.status, 201, JSON.stringify(response.data)); return response.data;
}

test('typed HTTP conditions preserve zero and false, combine all/any, and distinguish unset from negative or inapplicable fields', async () => {
  const f = await fixture();
  try {
    const before = (await f.call<WorkspaceSnapshot>('/workspace')).data;
    const cases: [IssueFieldFilter, string[]][] = [
      [filter({ fieldId: 'score', operator: 'equals', value: 0 }, { fieldId: 'approved', operator: 'equals', value: false }), [f.a.id]],
      [{ match: 'any', rules: [{ fieldId: 'score', operator: 'gte', value: 5 }, { fieldId: 'approved', operator: 'equals', value: false }] }, [f.a.id, f.b.id]],
      [filter({ fieldId: 'score', operator: 'lte', value: 0 }, { fieldId: 'when', operator: 'lte', value: '2026-11-19' }), [f.a.id]],
      [filter({ fieldId: 'notes', operator: 'contains', value: '검증' }, { fieldId: 'url', operator: 'equals', value: 'https://example.test/A' }), [f.a.id]],
      [filter({ fieldId: 'reviewer', operator: 'equals', value: 'user-yun' }, { fieldId: 'severity', operator: 'equals', value: 'major' }), [f.a.id]],
      [filter({ fieldId: 'tags', operator: 'includes', value: 'red' }), [f.a.id]],
      [filter({ fieldId: 'tags', operator: 'excludes', value: 'red' }), [f.b.id]],
      [filter({ fieldId: 'score', operator: 'not_equals', value: 0 }), [f.b.id]],
      [filter({ fieldId: 'score', operator: 'is_set' }), [f.a.id, f.b.id]],
      [filter({ fieldId: 'approved', operator: 'is_empty' }), [f.c.id, f.d.id]],
      [filter({ fieldId: 'scoped', operator: 'is_empty' }), [f.d.id]],
    ];
    for (const [condition, expected] of cases) assert.deepEqual(await query(f, condition), [...expected].sort(), JSON.stringify(condition));
    const invalidRules = [
      { fieldId: 'score', operator: 'equals', value: '0' }, { fieldId: 'approved', operator: 'equals', value: 'false' },
      { fieldId: 'when', operator: 'gte', value: '2026-02-30' }, { fieldId: 'severity', operator: 'equals', value: 'missing-option' },
      { fieldId: 'reviewer', operator: 'equals', value: 'missing-user' }, { fieldId: 'score', operator: 'contains', value: 0 },
      { fieldId: 'unknown', operator: 'is_set' },
    ];
    for (const rule of invalidRules) assert.equal((await f.call('/issues/query', 'POST', { projectId: f.project.id, fieldFilter: { match: 'all', rules: [rule] } })).status, 400);
    assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).data, before);
  } finally { await f.close(); }
});

test('shared views retain typed conditions, reject bad values atomically, enforce CAS and canonically clear null or omitted conditions', async () => {
  const f = await fixture();
  try {
    const condition = filter({ fieldId: 'score', operator: 'equals', value: 0 }, { fieldId: 'approved', operator: 'equals', value: false });
    let view = await save(f, '합성 정밀 조건 보기', condition);
    assert.deepEqual(view.filters.fieldFilter, condition);
    const badFilter = { ...basicFilters, fieldFilter: filter({ fieldId: 'score', operator: 'equals', value: '0' }) };
    assert.equal((await f.call(`/views/${view.id}`, 'PATCH', { expectedVersion: view.version, filters: badFilter })).status, 400);
    assert.equal((await f.call('/views', 'POST', { projectId: f.project.id, name: '거절할 보기', layout: 'list', filters: badFilter })).status, 400);
    assert.deepEqual((await f.call<SavedView[]>(`/views?projectId=${f.project.id}`)).data, [view]);
    const edited = await f.call<SavedView>(`/views/${view.id}`, 'PATCH', { expectedVersion: view.version, name: '검토한 합성 조건 보기' }); assert.equal(edited.status, 200); view = edited.data;
    assert.equal((await f.call(`/views/${view.id}`, 'PATCH', { expectedVersion: 1, name: '오래된 편집' })).status, 409);
    const cleared = await f.call<SavedView>(`/views/${view.id}`, 'PATCH', { expectedVersion: view.version, filters: { ...basicFilters, fieldFilter: null } }); assert.equal(cleared.status, 200); assert.equal(Object.hasOwn(cleared.data.filters, 'fieldFilter'), false);
    const reset = await f.call<SavedView>(`/views/${view.id}`, 'PATCH', { expectedVersion: cleared.data.version, filters: { ...basicFilters, fieldFilter: condition } }); assert.equal(reset.status, 200);
    const omitted = await f.call<SavedView>(`/views/${view.id}`, 'PATCH', { expectedVersion: reset.data.version, filters: basicFilters }); assert.equal(omitted.status, 200); assert.equal(Object.hasOwn(omitted.data.filters, 'fieldFilter'), false);
    const invalidReferences = [filter({ fieldId: 'severity', operator: 'equals', value: 'no-option' }), filter({ fieldId: 'reviewer', operator: 'equals', value: 'no-user' })];
    for (const fieldFilter of invalidReferences) assert.equal((await f.call(`/views/${view.id}`, 'PATCH', { expectedVersion: omitted.data.version, filters: { ...basicFilters, fieldFilter } })).status, 400);
  } finally { await f.close(); }
});

test('view references protect unused fields and options from removal while archived field and option IDs remain queryable', async () => {
  const f = await fixture();
  try {
    const protectedView = await save(f, '값이 아직 없는 선택지 보기', filter({ fieldId: 'future', operator: 'equals', value: 'unused' }));
    const removedField = await f.call(f.schemaPath, 'PATCH', { ...f.schema, expectedVersion: f.schema.version, fields: f.schema.fields.filter(field => field.id !== 'future') }); assert.equal(removedField.status, 409);
    const removedOption = await f.call(f.schemaPath, 'PATCH', { ...f.schema, expectedVersion: f.schema.version, fields: f.schema.fields.map(field => field.id === 'future' ? { ...field, options: field.options.filter(option => option.id !== 'unused') } : field) }); assert.equal(removedOption.status, 409);
    assert.deepEqual((await f.call<ProjectIssueSchema>(f.schemaPath)).data, f.schema);
    const archived = await f.call<ProjectIssueSchema>(f.schemaPath, 'PATCH', { ...f.schema, expectedVersion: f.schema.version, fields: f.schema.fields.map(field => ['future', 'severity'].includes(field.id) ? { ...field, archived: true, options: field.options.map(option => ['unused', 'major'].includes(option.id) ? { ...option, archived: true } : option) } : field) });
    assert.equal(archived.status, 200, JSON.stringify(archived.data));
    assert.deepEqual(await query(f, protectedView.filters.fieldFilter!), []);
    assert.deepEqual(await query(f, filter({ fieldId: 'severity', operator: 'equals', value: 'major' })), [f.a.id]);
    const savedArchived = await save(f, '보관된 값 조회', filter({ fieldId: 'severity', operator: 'equals', value: 'major' })); assert.equal(savedArchived.filters.fieldFilter?.rules[0].value, 'major');
    const before = (await f.call<WorkspaceSnapshot>('/workspace')).data;
    assert.equal(before.issues.find(issue => issue.id === f.a.id)?.customFields?.severity, 'major');
  } finally { await f.close(); }
});

test('native13 preserves typed shared views, rejects malformed or older-header loss atomically, and read API keys can query only their projects', async () => {
  const f = await fixture();
  try {
    const condition = filter({ fieldId: 'score', operator: 'equals', value: 0 }, { fieldId: 'approved', operator: 'equals', value: false });
    const view = await save(f, '백업할 합성 조건 보기', condition);
    const key = await f.call<ApiKeyCreated>('/api-keys', 'POST', { name: '합성 필드 조회 전용 키', access: 'read', projectIds: [f.project.id], expiresAt: null }); assert.equal(key.status, 201);
    const beforeQuery = (await f.call<WorkspaceSnapshot>('/workspace')).data;
    assert.deepEqual(await query(f, condition, key.data.token), [f.a.id]);
    assert.equal((await f.call('/v1/issues/query', 'POST', { projectId: 'project-team', fieldFilter: condition }, key.data.token)).status, 403);
    assert.equal((await f.call('/v1/issues', 'POST', { projectId: f.project.id, title: '읽기 키의 금지된 쓰기' }, key.data.token)).status, 403);
    assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).data, beforeQuery);
    const backup = (await f.call<Backup>('/export')).data; assert.equal(backup.schemaVersion, 13); assert.deepEqual(backup.savedViews!.find(value => value.id === view.id)?.filters.fieldFilter, condition);
    const edited = await f.call<SavedView>(`/views/${view.id}`, 'PATCH', { expectedVersion: view.version, name: '백업 후 임시 편집', filters: basicFilters }); assert.equal(edited.status, 200);
    const beforeRestore = (await f.call<WorkspaceSnapshot>('/workspace')).data;
    const malformed = structuredClone(backup); malformed.savedViews!.find(value => value.id === view.id)!.filters.fieldFilter!.rules[0].value = '0';
    assert.equal((await f.call('/import', 'POST', { data: malformed })).status, 400); assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).data, beforeRestore);
    const olderTyped = structuredClone(backup); olderTyped.schemaVersion = 12;
    assert.equal((await f.call('/import', 'POST', { data: olderTyped })).status, 400); assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).data, beforeRestore);
    const restored = await f.call('/import', 'POST', { data: backup }); assert.equal(restored.status, 200, JSON.stringify(restored.data));
    const restoredView = (await f.call<SavedView[]>(`/views?projectId=${f.project.id}`)).data.find(value => value.id === view.id)!;
    assert.equal(restoredView.name, view.name); assert.deepEqual(restoredView.filters.fieldFilter, condition); assert.ok(restoredView.version > edited.data.version);
    assert.deepEqual(await query(f, condition), [f.a.id]);
    const legacy = structuredClone(backup); legacy.schemaVersion = 12; for (const saved of legacy.savedViews!) delete saved.filters.fieldFilter;
    const importedLegacy = await f.call('/import', 'POST', { data: legacy }); assert.equal(importedLegacy.status, 200, JSON.stringify(importedLegacy.data));
    assert.ok((await f.call<SavedView[]>(`/views?projectId=${f.project.id}`)).data.every(value => !Object.hasOwn(value.filters, 'fieldFilter')));
  } finally { await f.close(); }
});
