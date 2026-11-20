import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { ApiKeyCreated, JiraIssueStatusHistoryPage, LegacyPackageSummary, MigrationApplyResult, MigrationConfiguration,
  MigrationOptions, MigrationPreview, SourceRecordArchive, SourceRecordPage, WorkspaceSnapshot } from '../../shared/types.js';
import { zip } from '../fixtures/legacy-export-zip.mjs';

const created = '2025-01-01T00:00:00Z';
const project = { id: '4100', key: 'JIRA', name: '원본 프로젝트' };
const actor = { key: 'actor-jira', displayName: '원본 작성자' };
const historicalTitle = '이력이 있는 업무';

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'teamspace-jira-history-'));
  const service = createApp({ dataDir, outboundWorker: false });
  const server = service.app.listen(0, '127.0.0.1');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    service.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}/api`;
  async function call<T = unknown>(route: string, method = 'GET', input?: unknown, expected = 200, headers: Record<string, string> = {}) {
    const response = await fetch(origin + route, {
      method,
      headers: { 'X-Actor-Id': 'user-seo', 'Content-Type': 'application/json', ...headers },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    const raw = await response.text();
    assert.equal(response.status, expected, `${method} ${route}: ${raw}`);
    if (route.endsWith('/jira-status-history') && !route.startsWith('/v1/')) assert.equal(response.headers.get('Cache-Control'), 'no-store');
    return JSON.parse(raw) as T;
  }
  async function options(filename: string, bytes: Buffer) {
    const query = new URLSearchParams({ filename, product: 'jira', instanceKey: 'synthetic-jira-status-history' });
    const response = await fetch(`${origin}/legacy-import/packages?${query}`, {
      method: 'POST', headers: { 'X-Actor-Id': 'user-seo', 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(bytes),
    });
    const raw = await response.text();
    assert.equal(response.status, 201, raw);
    const pkg = JSON.parse(raw) as LegacyPackageSummary;
    return { pkg, ...await call<MigrationOptions>(`/migrations/options?packageId=${pkg.id}`) };
  }
  const preview = (configuration: MigrationConfiguration) => call<MigrationPreview>('/migrations/preview', 'POST', { configuration }, 201);
  async function apply(configuration: MigrationConfiguration) {
    const plan = await preview(configuration);
    assert.ok(plan.canApply, JSON.stringify(plan.notices));
    const result = await call<MigrationApplyResult>(`/migrations/previews/${plan.id}/apply`, 'POST', {
      expectedVersion: plan.version, acknowledgements: plan.requiredAcknowledgements,
    }, 201);
    return result.import;
  }
  return { call, options, preview, apply, dataDir };
}

function adminPackage() {
  const group = (id: number, date: string, issue = '4401', visibility = '') =>
    `<ChangeGroup id="${id}" issue="${issue}" author="jira-alice" created="${date}" ${visibility}/>`;
  const status = (id: number, from: string, to: string, type = 'jira') =>
    `<ChangeItem id="${id + 1000}" group="${id}" field="status" fieldtype="${type}" oldvalue="1" oldstring="${from}" newvalue="2" newstring="${to}"/>`;
  const entities = `<entity-engine-xml version="9.12">
    <ApplicationUser id="10" userKey="${actor.key}" lowerUserName="jira-alice"/>
    <User id="11" userName="jira-alice" displayName="${actor.displayName}" active="1"/>
    <Project id="${project.id}" pkey="${project.key}" name="${project.name}"/>
    <Status id="1" pname="Open"/><Status id="2" pname="In Progress"/><IssueType id="3" pname="Task"/>
    <Issue id="4401" project="${project.id}" number="1" summary="${historicalTitle}" status="1" issuetype="3" created="${created}" updated="${created}"/>
    <Issue id="4402" project="${project.id}" number="2" summary="이력이 없는 업무" status="1" issuetype="3" created="${created}" updated="${created}"/>
    ${group(501, '2025-01-03 13:20:00.000')}${status(501, '보관된 상태 이름', '보관된 다음 상태')}
    ${group(502, '18/Jan/25 10:20 AM')}${status(502, '시각 보류', '분석 대기')}
    ${group(503, '2025-01-10T07:00:00Z')}${status(503, '제외된 이전 상태', '제외된 다음 상태')}
    ${group(504, '2025-01-10T07:00:00Z')}${status(504, '다른 사용자 정의 필드', '상태 변경이 아님', 'custom')}
    ${group(505, '2025-01-10T07:00:00Z', '4401', 'restricted="true"')}${status(505, '그룹 제한', '숨김')}
    ${group(506, '2025-01-10T07:00:00Z')}${status(506, '동일 그룹의 제한', '숨김')}
    <ChangeItem id="1516" group="506" field="description" fieldtype="jira" newstring="같은 그룹의 제한된 항목" roleLevel="7"/>
    </entity-engine-xml>`;
  return zip([{ path: 'entities.xml', bytes: Buffer.from(entities) }]);
}

const restStatus = (from: string, fromString: string, to: string, toString: string) =>
  ({ fieldId: 'status', field: '상태', fieldtype: 'jira', from, fromString, to, toString });

function restPackage() {
  const task = (id: string, number: number, summary: string) => ({ id, key: `${project.key}-${number}`,
    fields: { project, summary, created, updated: created, status: { id: '1', name: 'Open' }, issuetype: { id: '3', name: 'Task' } } });
  return Buffer.from(JSON.stringify({ issues: [{ ...task('4401', 1, historicalTitle), changelog: { histories: [
    { id: '501', author: actor, created: '2025-01-03T04:20:00Z', items: [restStatus('1', '보관된 상태 이름', '2', '보관된 다음 상태')] },
    { id: '601', author: actor, created: '2025-01-05T18:00:00+0900', items: [restStatus('2', '작업 중 기록', '3', '종료 기록')] },
    { id: '602', author: actor, created: '2025-01-05T22:00:00+0900', visibility: { type: 'role', value: 'Jira Team' },
      items: [restStatus('2', '제한된 REST 이력', '3', '숨김')] },
  ] } }, task('4403', 3, '함께 추가하는 업무')] }));
}

test('Jira status history reads preserved source transitions across initial migration and retained appends', async t => {
  const f = await fixture(t);
  const initial = await f.options('jira-admin.zip', adminPackage());
  const configuration = { ...initial.defaultConfiguration, timezone: 'Asia/Seoul' };
  const blocked = await f.preview(configuration);
  assert.equal(blocked.canApply, false);
  assert.deepEqual(blocked.notices.filter(notice => notice.code === 'RESTRICTED_CONTENT').map(notice => notice.recordId).sort(),
    [505, 506].map(id => `${initial.pkg.id}/history:${id}`));
  const receipt = await f.apply({ ...configuration, excludedRecords: [503, 505, 506].map(id => `${initial.pkg.id}/history:${id}`) });
  const [projectId] = receipt.projectIds;
  const workspace = () => f.call<WorkspaceSnapshot>('/workspace');
  const before = await workspace();
  const issue = before.issues.find(item => item.projectId === projectId && item.title === historicalTitle);
  const untouched = before.issues.find(item => item.projectId === projectId && item.title === '이력이 없는 업무');
  assert.ok(issue && untouched);
  const history = `/issues/${issue.id}/jira-status-history`;
  const page = (query = '') => f.call<JiraIssueStatusHistoryPage>(history + query);

  const first = await page('?limit=1');
  assert.deepEqual({ total: first.total, offset: first.offset, limit: first.limit }, { total: 2, offset: 0, limit: 1 });
  const [entry] = first.entries;
  assert.equal(entry.sourceImportId, receipt.id);
  assert.equal(entry.changedAt, '2025-01-03T04:20:00.000Z');
  assert.equal(entry.originalChangedAt, null);
  assert.equal(entry.originalAuthorName, actor.displayName);
  assert.deepEqual(entry.from, { id: '1', label: '보관된 상태 이름' });
  assert.deepEqual(entry.to, { id: '2', label: '보관된 다음 상태' });
  const original = await f.call<SourceRecordArchive>(`/source-imports/${entry.sourceImportId}/records/${entry.sourceRecordId}`);
  assert.equal(original.record.sourceId, '501');
  assert.equal(original.ownerId, issue.id);
  const unresolved = (await page('?offset=1&limit=1')).entries[0];
  assert.equal(unresolved.changedAt, null);
  assert.equal(unresolved.originalChangedAt, '18/Jan/25 10:20 AM');
  assert.deepEqual(await page('?offset=9'), { entries: [], total: 2, offset: 9, limit: 50 });
  assert.deepEqual(await f.call(`/issues/${untouched.id}/jira-status-history`), { entries: [], total: 0, offset: 0, limit: 50 });
  for (const query of ['?offset=-1', '?limit=101', '?limit=0', '?limit=2&limit=3', '?other=x']) await f.call(history + query, 'GET', undefined, 400);
  assert.deepEqual(await workspace(), before);

  // Older receipts could still carry an owner link before scoped history filtering was introduced.
  const db = new DatabaseSync(join(f.dataDir, 'teamspace.sqlite'));
  try {
    db.prepare(`UPDATE source_records SET owner_type='issue',owner_id=?,json=json_set(json_remove(json,'$.excluded'),'$.ownerType','issue','$.ownerId',?)
      WHERE import_id=? AND kind='history' AND source_id='506'`).run(issue.id, issue.id, receipt.id);
    const origins = await f.call<SourceRecordPage>(`/resource-origins?resourceType=issue&resourceId=${issue.id}&kind=history`);
    assert.ok(!origins.records.some(record => record.record.sourceId === '506'));
    assert.equal((await page()).total, 2);
    db.prepare(`UPDATE source_records SET owner_type=NULL,owner_id=NULL,json=json_set(json,'$.ownerType',NULL,'$.ownerId',NULL,'$.excluded',json('true'))
      WHERE import_id=? AND kind='history' AND source_id='506'`).run(receipt.id);
  } finally {
    db.close();
  }

  const api = await f.call<ApiKeyCreated>('/api-keys', 'POST', { name: 'migration history test', projectIds: [projectId], access: 'read', expiresAt: null }, 201);
  await f.call(`/v1${history}`, 'GET', undefined, 403, { Authorization: `Bearer ${api.token}` });
  const deleted = await f.call<{ trashEntryId: string }>(`/issues/${issue.id}`, 'DELETE', { expectedVersion: issue.version });
  await f.call(history, 'GET', undefined, 404);
  await f.call(`/trash/${deleted.trashEntryId}/restore`, 'POST', {});
  assert.deepEqual(await page('?limit=1'), first);

  const additional = await f.options('jira-rest.json', restPackage());
  const target = additional.appendTarget;
  assert.ok(target && target.projectId === projectId);
  const append = await f.apply({ ...additional.defaultConfiguration, timezone: 'Asia/Seoul', excludedRecords: [`${additional.pkg.id}/history:602`], appendTo: {
    projectId,
    statuses: Object.fromEntries(additional.statuses.map(value => [value.id, target.statuses.find(state => state.label === value.label)!.id])),
    issueTypes: Object.fromEntries(additional.issueTypes.map(value => [value.id, target.issueTypes.find(type => type.name === value.label)!.id])),
    fields: {},
  } });
  const combined = await page();
  assert.equal(combined.total, 3);
  const [continued, same, noTime] = combined.entries;
  assert.equal(continued.sourceImportId, append.id);
  assert.equal(continued.originalAuthorName, actor.displayName);
  assert.equal(continued.changedAt, '2025-01-05T09:00:00.000Z');
  assert.deepEqual(continued.to, { id: '3', label: '종료 기록' });
  assert.deepEqual(same, entry);
  assert.deepEqual(noTime, unresolved);
  const retained = await f.call<SourceRecordArchive>(`/source-imports/${append.id}/records/${continued.sourceRecordId}`);
  assert.equal(retained.ownerId, null);
  assert.equal(retained.record.sourceId, '601');
});
