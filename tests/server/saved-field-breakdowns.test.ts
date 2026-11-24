import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type { Issue, IssueFieldBreakdown, IssueFieldBreakdownPage, IssueFieldBreakdownQuery, Project, ProjectIssueSchema,
  SavedFieldBreakdown, SavedView, WorkspaceSnapshot } from '../../shared/types.js';

const projectKey = 'PRESET';
const actorId = 'user-seo';
const peerId = 'user-min';
const baseFilters = { query: '', status: 'all', assigneeId: 'all', type: 'all' };
type Backup = { schemaVersion: number; savedFieldBreakdowns: SavedFieldBreakdown[] } & Record<string, unknown>;

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'teamspace-saved-field-breakdown-'));
  async function start() {
    const runtime = createApp({ dataDir: directory, outboundWorker: false, deadlineReminderWorker: false, recurringIssueWorker: false });
    const server = runtime.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { runtime, server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api` };
  }
  let active = await start();
  async function stop() {
    try {
      await new Promise<void>((resolve, reject) => {
        active.server.close(error => error ? reject(error) : resolve());
        active.server.closeAllConnections();
      });
    } finally { active.runtime.close(); }
  }
  t.after(async () => {
    try { await stop(); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  });
  async function request<T>(path: string, method = 'GET', data?: unknown, actor = actorId) {
    const response = await fetch(active.url + path, { method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actor },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, data: await response.json() as T };
  }
  async function call<T>(path: string, status = 200, method = 'GET', data?: unknown, actor = actorId) {
    const result = await request<T>(path, method, data, actor);
    assert.equal(result.status, status, `${method} ${path}: ${JSON.stringify(result.data)}`);
    return result.data;
  }
  const project = await call<Project>('/projects', 201, 'POST', { key: projectKey, name: '저장 집계 검증 프로젝트' });
  const pathFor = (projectId: string) => `/projects/${projectId}/field-breakdown-presets`;
  const path = pathFor(project.id);
  const view = (title: string, query: string, projectId = project.id) => call<SavedView>('/views', 201, 'POST', {
    projectId, name: title, layout: 'board', filters: { ...baseFilters, query },
  });
  const issue = (title: string, assigneeId = actorId, customFields?: Issue['customFields']) => call<Issue>('/issues', 201, 'POST', {
    projectId: project.id, title, assigneeId, ...(customFields ? { customFields } : {}),
  });
  const list = (id = project.id) => call<SavedFieldBreakdown[]>(pathFor(id));
  const run = (query: IssueFieldBreakdownQuery, status = 200) => call<IssueFieldBreakdown>(`/projects/${project.id}/field-breakdown`, status, 'POST', query);
  return { call, request, project, path, pathFor, view, issue, list, run, async restart() { await stop(); active = await start(); } };
}

test('named report conditions are shared, scope-checked and rerun the current saved view and ticket values', async t => {
  const f = await fixture(t);
  const target = await f.issue('배포 검증 첫 업무');
  await f.issue('업무 보기 밖의 다른 업무', peerId);
  const view = await f.view('배포 보드', '배포 검증');
  const query = { groupBy: 'status', comparisonBy: 'assignee', savedViewId: view.id } as const;
  const results = await Promise.all([
    f.request<SavedFieldBreakdown>(f.path, 'POST', { name: ' Café 배포 현황 ', query }),
    f.request<SavedFieldBreakdown>(f.path, 'POST', { name: 'CAFE\u0301 배포 현황', query }, peerId),
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 201]);
  assert.deepEqual(results[0].data, results[1].data);
  const preset = results[0].data;
  assert.deepEqual(preset.query, query);
  assert.equal(preset.version, 1);
  assert.equal((await f.list()).length, 1);
  await f.call(f.path, 409, 'POST', { name: 'café 배포 현황', query: { groupBy: 'priority' } });
  const snapshot = await f.call<WorkspaceSnapshot>('/workspace');
  assert.equal(snapshot.activities.filter(activity => activity.resourceId === f.project.id && activity.action === '필드 집계 저장').length, 1);

  const first = await f.run(preset.query);
  assert.equal(first.totalIssues, 1);
  assert.equal(first.savedView?.id, view.id);
  assert.equal(first.comparison?.by, 'assignee');
  const row = first.groups.find(group => group.count === 1);
  const column = first.comparison?.columns.find(bucket => bucket.count === 1);
  assert.ok(row && column);
  const drill = await f.call<IssueFieldBreakdownPage>(`/projects/${f.project.id}/field-breakdown/issues`, 200, 'POST', {
    ...query, revision: first.revision, bucketId: row.id, comparisonBucketId: column.id,
  });
  assert.deepEqual(drill.issues.map(issue => issue.id), [target.id]);
  await f.issue('배포 검증 둘째 업무', peerId);
  await f.restart();
  assert.deepEqual((await f.list())[0], preset);
  const later = await f.run(preset.query);
  assert.equal(later.totalIssues, 2);
  assert.notEqual(later.revision, first.revision);
  const changedView = await f.call<SavedView>(`/views/${view.id}`, 200, 'PATCH', {
    expectedVersion: view.version, filters: { ...view.filters, query: '둘째' },
  });
  const narrowed = await f.run(preset.query);
  assert.equal(narrowed.savedView?.version, changedView.version);
  assert.equal(narrowed.totalIssues, 1);
  assert.equal(narrowed.comparison?.columns[0].count, 1);
});

test('named reports retain deleted scopes, accept explicit replacements and check ownership and update versions', async t => {
  const f = await fixture(t);
  const other = await f.call<Project>('/projects', 201, 'POST', { key: 'OTHER', name: '다른 보고서 프로젝트' });
  const foreign = await f.view('다른 프로젝트 보기', '', other.id);
  await f.call(f.path, 404, 'POST', { name: '외부 보기', query: { groupBy: 'status', savedViewId: foreign.id } });
  await f.call(f.path, 400, 'POST', { name: '동일 행과 열', query: { groupBy: 'priority', comparisonBy: 'priority' } });
  await f.call(f.path, 404, 'POST', { name: '없는 필드', query: { fieldId: 'missing' } });

  const schemaPath = `/projects/${f.project.id}/issue-schema`;
  const schema = await f.call<ProjectIssueSchema>(schemaPath);
  const effort = { id: 'effort', name: '검증 시간', kind: 'number' as const, archived: false, required: false, options: [], issueTypes: [], description: '' };
  const defined = await f.call<ProjectIssueSchema>(schemaPath, 200, 'PATCH', { ...schema, expectedVersion: schema.version, fields: [effort] });
  await f.issue('검증 시간이 있는 업무', actorId, { effort: 3 });
  await f.call(schemaPath, 200, 'PATCH', { ...defined, expectedVersion: defined.version, fields: [{ ...effort, archived: true }] });
  const archived = await f.call<SavedFieldBreakdown>(f.path, 201, 'POST', { name: '보관된 검증 시간', query: { fieldId: 'effort' } });
  assert.equal((await f.run(archived.query)).field.archived, true);

  const view = await f.view('삭제할 보기', '검증');
  const saved = await f.call<SavedFieldBreakdown>(f.path, 201, 'POST', { name: '복구할 집계', query: { groupBy: 'status', savedViewId: view.id } });
  const path = `${f.path}/${saved.id}`;
  await f.call(`${f.pathFor(other.id)}/${saved.id}`, 404, 'PATCH', { expectedVersion: saved.version, name: '다른 스코프' });
  await f.call(`/views/${view.id}?expectedVersion=${view.version}`, 200, 'DELETE');
  assert.deepEqual((await f.list()).find(preset => preset.id === saved.id)?.query, saved.query);
  await f.run(saved.query, 404);
  const renamed = await f.call<SavedFieldBreakdown>(path, 200, 'PATCH', { expectedVersion: saved.version, name: '아직 복구할 집계' }, peerId);
  assert.deepEqual(renamed.query, saved.query);
  await f.call(path, 409, 'PATCH', { expectedVersion: saved.version, query: { groupBy: 'status' } });
  const repaired = await f.call<SavedFieldBreakdown>(path, 200, 'PATCH', { expectedVersion: renamed.version, query: { groupBy: 'reporter', comparisonBy: 'priority' } });
  assert.equal((await f.run(repaired.query)).totalIssues, 1);
  await f.call(`${path}?expectedVersion=${renamed.version}`, 409, 'DELETE');
  await f.call(`${path}?expectedVersion=${repaired.version}`, 200, 'DELETE');
  assert.deepEqual(await f.list(), [archived]);
});

test('native v92 preserves named queries and retained missing sources, rejecting stale writes after a deleted report is revived', async t => {
  const f = await fixture(t);
  const other = await f.call<Project>('/projects', 201, 'POST', { key: 'FAR', name: '백업의 다른 프로젝트' });
  const foreign = await f.view('다른 프로젝트 보고서 보기', '', other.id);
  const view = await f.view('삭제될 보고서 보기', '배포');
  const orphan = await f.call<SavedFieldBreakdown>(f.path, 201, 'POST', { name: '보기가 삭제된 집계', query: { groupBy: 'status', savedViewId: view.id } });
  await f.call(`/views/${view.id}?expectedVersion=${view.version}`, 200, 'DELETE');
  const original = await f.call<SavedFieldBreakdown>(f.path, 201, 'POST', { name: '백업할 집계', query: { groupBy: 'priority' } });
  const backup = await f.call<Backup>('/export');
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.deepEqual(new Map(backup.savedFieldBreakdowns.map(preset => [preset.id, preset])).get(orphan.id), orphan);
  const path = `${f.path}/${original.id}`;
  const removed = await f.call<SavedFieldBreakdown>(path, 200, 'PATCH', { expectedVersion: original.version, name: '삭제 전 변경된 이름' });
  await f.call(`${path}?expectedVersion=${removed.version}`, 200, 'DELETE');

  const replace = (data: unknown, status = 200) => f.call('/import', status, 'POST', { data });
  await replace({ ...backup, schemaVersion: 91 }, 400);
  const missingList = { ...backup } as Partial<Backup>;
  delete missingList.savedFieldBreakdowns;
  await replace(missingList, 400);
  await replace({ ...backup, savedFieldBreakdowns: [original, { ...original, id: 'other-id', name: `${original.name}` }] }, 400);
  await replace({ ...backup, savedFieldBreakdowns: [{ ...orphan, query: { groupBy: 'status', savedViewId: foreign.id } }] }, 400);
  assert.deepEqual(await f.list(), [orphan]);

  await replace({ ...backup, schemaVersion: 92 });
  const restored = (await f.list()).find(preset => preset.id === original.id)!;
  assert.ok(restored.version > removed.version);
  assert.deepEqual(restored.query, original.query);
  assert.equal(restored.name, original.name);
  await f.call(path, 409, 'PATCH', { expectedVersion: removed.version, name: '복원 전 입력' });
  await f.run(orphan.query, 404);
  await replace({ ...missingList, schemaVersion: 91 });
  assert.deepEqual(await f.list(), []);
});

test('native v95 restores custom comparison presets and their retained missing fields with exact write versions', async t => {
  const f = await fixture(t);
  const schemaPath = `/projects/${f.project.id}/issue-schema`;
  const schema = await f.call<ProjectIssueSchema>(schemaPath);
  const choice = { id: 'classification', name: '합성 분류', kind: 'select' as const, description: '', required: false, issueTypes: [], archived: false,
    options: [{ id: 'checked', name: '합성 점검', archived: false }] };
  const flag = { ...choice, id: 'retired', name: '이전 검토 항목', kind: 'checkbox' as const, options: [] };
  const defined = await f.call<ProjectIssueSchema>(schemaPath, 200, 'PATCH', { ...schema, expectedVersion: schema.version, fields: [choice, flag] });
  const view = await f.view('공유 검증 보기', '배포 검증');
  await f.issue('배포 검증 업무', actorId, { classification: 'checked' });
  await f.issue('다른 제목', actorId, { classification: 'checked' });
  const query = { groupBy: 'priority', comparisonFieldId: choice.id, savedViewId: view.id } as const;
  const original = await f.call<SavedFieldBreakdown>(f.path, 201, 'POST', { name: '공유 사용자 정의 비교', query });
  assert.deepEqual(original.query, query);
  assert.deepEqual(await f.call<SavedFieldBreakdown>(f.path, 200, 'POST', { name: original.name, query }, peerId), original);
  await f.call(f.path, 409, 'POST', { name: original.name, query: { ...query, comparisonFieldId: flag.id } });
  await f.call(f.path, 400, 'POST', { name: '잘못된 두 비교 기준', query: { ...query, comparisonBy: 'assignee' } });
  await f.call(f.path, 404, 'POST', { name: '없어진 새 비교 기준', query: { ...query, comparisonFieldId: 'unavailable' } });
  const before = await f.run(original.query);
  assert.equal(before.totalIssues, 1);
  assert.equal(before.comparison?.field?.id, choice.id);
  assert.equal(before.comparison?.columns.find(column => column.label === choice.options[0].name)?.count, 1);

  const orphan = await f.call<SavedFieldBreakdown>(f.path, 201, 'POST', { name: '비교 필드를 삭제한 집계', query: { groupBy: 'status', comparisonFieldId: flag.id } });
  await f.call(schemaPath, 200, 'PATCH', { ...defined, expectedVersion: defined.version, fields: [{ ...choice, archived: true }] });
  await f.run(orphan.query, 404);
  const historical = await f.run(original.query);
  assert.equal(historical.comparison?.field?.archived, true);
  assert.equal(historical.comparison?.columns.find(column => column.label === choice.options[0].name)?.count, 1);

  const backup = await f.call<Backup>('/export');
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.deepEqual(backup.savedFieldBreakdowns.find(preset => preset.id === original.id), original);
  assert.deepEqual(backup.savedFieldBreakdowns.find(preset => preset.id === orphan.id), orphan);
  const path = `${f.path}/${original.id}`;
  const renamed = await f.call<SavedFieldBreakdown>(path, 200, 'PATCH', { expectedVersion: original.version, name: '복원 전 수정된 이름' });
  await f.call(`${path}?expectedVersion=${renamed.version}`, 200, 'DELETE');
  await f.call('/import', 400, 'POST', { data: { ...backup, schemaVersion: 94 } });
  assert.deepEqual(await f.list(), [orphan]);

  await f.call('/import', 200, 'POST', { data: backup });
  const presets = await f.list();
  const restored = presets.find(preset => preset.id === original.id)!;
  const restoredOrphan = presets.find(preset => preset.id === orphan.id)!;
  assert.ok(restored.version > renamed.version);
  assert.deepEqual(restored.query, original.query);
  assert.deepEqual(restoredOrphan.query, orphan.query);
  await f.call(path, 409, 'PATCH', { expectedVersion: renamed.version, name: '복원 전 오래된 입력' });
  const after = await f.run(restored.query);
  assert.equal(after.totalIssues, 1);
  assert.notEqual(after.revision, historical.revision);
  await f.run(restoredOrphan.query, 404);
  const fixed = await f.call<SavedFieldBreakdown>(`${f.path}/${orphan.id}`, 200, 'PATCH', {
    expectedVersion: restoredOrphan.version, query: { groupBy: 'status', comparisonFieldId: choice.id },
  });
  assert.equal((await f.run(fixed.query)).comparison?.field?.id, choice.id);
});

test('numeric measure presets preserve portable inputs and orphaned measures while rejecting an older format claim', async t => {
  const f = await fixture(t);
  const schemaPath = `/projects/${f.project.id}/issue-schema`;
  const schema = await f.call<ProjectIssueSchema>(schemaPath);
  const score = { id: 'score', name: '측정 점수', kind: 'number' as const, description: '', required: false, issueTypes: [], archived: false, options: [] };
  const retired = { ...score, id: 'retired', name: '나중에 지울 측정값' };
  const textField = { ...score, id: 'description', name: '측정할 수 없는 텍스트', kind: 'text' as const };
  const defined = await f.call<ProjectIssueSchema>(schemaPath, 200, 'PATCH', { ...schema, expectedVersion: schema.version, fields: [score, retired, textField] });
  const view = await f.view('배포 업무 보기', '배포');
  await f.issue('배포 대상 업무', actorId, { score: 7 });
  await f.issue('보기 외부 업무', actorId, { score: 99 });
  const query: IssueFieldBreakdownQuery = { groupBy: 'status', comparisonBy: 'assignee', savedViewId: view.id, measure: { kind: 'custom', fieldId: score.id } };
  const preset = await f.call<SavedFieldBreakdown>(f.path, 201, 'POST', { name: '배포 점수 합계', query });
  assert.deepEqual(preset.query, query);
  assert.deepEqual(await f.call<SavedFieldBreakdown>(f.path, 200, 'POST', { name: preset.name, query }, peerId), preset);
  await f.call(f.path, 409, 'POST', { name: preset.name, query: { ...query, measure: { kind: 'estimate' } } });
  await f.call(f.path, 409, 'POST', { name: preset.name, query: { ...query, measure: { kind: 'custom', fieldId: retired.id } } });
  await f.call(f.path, 400, 'POST', { name: '잘못된 측정값', query: { ...query, measure: { kind: 'custom', fieldId: textField.id } } });
  await f.call(f.path, 404, 'POST', { name: '이 프로젝트에 없는 측정값', query: { ...query, measure: { kind: 'custom', fieldId: 'missing' } } });
  const orphan = await f.call<SavedFieldBreakdown>(f.path, 201, 'POST', {
    name: '측정값을 포함한 이전 집계', query: { ...query, measure: { kind: 'custom', fieldId: retired.id } },
  });
  await f.call(schemaPath, 200, 'PATCH', { ...defined, expectedVersion: defined.version, fields: [score, textField] });
  await f.run(orphan.query, 404);
  const report = await f.run(preset.query);
  assert.deepEqual(report.measure?.total, { valueCount: 1, sum: 7 });

  const backup = await f.call<Backup>('/export');
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  assert.ok(backup.schemaVersion >= 107);
  assert.deepEqual(backup.savedFieldBreakdowns.find(value => value.id === preset.id), preset);
  const path = `${f.path}/${preset.id}`;
  const renamed = await f.call<SavedFieldBreakdown>(path, 200, 'PATCH', { expectedVersion: preset.version, name: '복원 전 다른 이름' });
  const rejected = await f.call<{ error: string }>('/import', 400, 'POST', { data: { ...backup, schemaVersion: 106 } });
  assert.match(rejected.error, /schemaVersion 107/u);
  assert.deepEqual((await f.list()).find(value => value.id === preset.id), renamed);
  await f.call('/import', 200, 'POST', { data: backup });
  const restored = await f.list();
  const measured = restored.find(value => value.id === preset.id);
  const missing = restored.find(value => value.id === orphan.id);
  assert.ok(measured && missing && measured.version > renamed.version);
  assert.deepEqual(measured.query, query);
  assert.deepEqual(missing.query, orphan.query);
  assert.deepEqual((await f.run(measured.query)).measure?.total, report.measure?.total);
  await f.run(missing.query, 404);
  await f.call(path, 409, 'PATCH', { expectedVersion: renamed.version, name: '잘못된 이전 버전' });
});
