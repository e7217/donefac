import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import fileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { createApp } from '../../server/app.js';
import type { IssueProjectMovePreview, IssueProjectMoveResult } from '../../shared/issue-project-move.js';
import type { ApiKeyCreated, JiraIssueStatusHistoryPage, LegacyPackageSummary, MigrationApplyResult, MigrationConfiguration,
  MigrationOptions, MigrationPreview, SourceImport, SourceReconciliationAudit, SourceReconciliationJiraFinding, SourceReconciliationJiraStatusFindingsPage,
  SourceRecordArchive, SourceRecordPage, WorkspaceSnapshot } from '../../shared/types.js';
import { zip } from '../fixtures/legacy-export-zip.mjs';

const created = '2025-01-01T00:00:00Z';
const project = { id: '4100', key: 'JIRA', name: '원본 프로젝트' };
const actor = { key: 'actor-jira', displayName: '원본 작성자' };
const historicalTitle = '이력이 있는 업무';
const sourceInstance = 'synthetic-jira-status-history';

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
    if (!route.startsWith('/v1/') && /\/jira-status-(history|findings)(\?|$)/.test(route)) {
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
    return JSON.parse(raw) as T;
  }
  async function options(filename: string, bytes: Buffer) {
    const query = new URLSearchParams({ filename, product: 'jira', instanceKey: sourceInstance });
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

function restPackage(afterMove = false) {
  const bytes = Buffer.from('Synthetic attachment for the asynchronous audit');
  const attachmentId = afterMove ? '681' : '680';
  const task = (id: string, number: number, summary: string) => ({ id, key: `${project.key}-${number}`,
    fields: { project, summary, created, updated: created, status: { id: '1', name: 'Open' }, issuetype: { id: '3', name: 'Task' } } });
  const added = afterMove ? task('4404', 4, '이동 후 함께 추가하는 업무') : task('4403', 3, '함께 추가하는 업무');
  const entities = Buffer.from(JSON.stringify({ issues: [{ ...task('4401', 1, historicalTitle), changelog: { histories: [
    { id: '501', author: actor, created: '2025-01-03T04:20:00Z', items: [restStatus('1', '보관된 상태 이름', '2', '보관된 다음 상태')] },
    { id: afterMove ? '603' : '601', author: actor, created: '2025-01-05T18:00:00+0900',
      items: [restStatus('2', '작업 중 기록', '3', afterMove ? '이동 뒤 원본에만 보관한 기록' : '종료 기록')] },
    { id: '602', author: actor, created: '2025-01-05T22:00:00+0900', visibility: { type: 'role', value: 'Jira Team' },
      items: [restStatus('2', '제한된 REST 이력', '3', '숨김')] },
  ] } }, { ...added, fields: { ...added.fields, attachment: [{ id: attachmentId, filename: 'evidence.bin', size: bytes.length, created }] } }] }));
  return zip([{ path: 'issues.json', bytes: entities }, { path: `attachments/${attachmentId}`, bytes }]);
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
  const auditPath = ({ id, version }: SourceImport) => `/source-imports/${id}/reconciliation/audit?expectedVersion=${version}`;
  const audit = (source: SourceImport) => f.call<SourceReconciliationAudit>(auditPath(source));
  const findingsPath = `/source-imports/${receipt.id}/reconciliation/jira-status-findings`;
  const findings = (finding: SourceReconciliationJiraFinding, options = '') => f.call<SourceReconciliationJiraStatusFindingsPage>(
    `${findingsPath}?expectedVersion=${receipt.version}&finding=${finding}${options}`);

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
  const initialSummary = (await audit(receipt)).jiraStatusHistory;
  assert.ok(initialSummary);
  assert.equal(initialSummary.projected.count, first.total);
  assert.match(initialSummary.projected.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(initialSummary, {
    sourceChanges: 5, projected: { count: 2, sha256: initialSummary.projected.sha256 }, duplicate: 0,
    excluded: 3, restricted: 0, unavailable: 0, unresolvedTime: 1, unresolvedAuthor: 0,
  });

  const excludedPage = await findings('excluded', '&limit=2');
  assert.deepEqual({ ...excludedPage, rows: excludedPage.rows.length }, {
    importId: receipt.id, receiptVersion: receipt.version, finding: 'excluded', rows: 2, total: 3, totalChanges: 3,
    offset: 0, limit: 2, fingerprint: excludedPage.fingerprint,
  });
  assert.match(excludedPage.fingerprint, /^[a-f0-9]{64}$/);
  const excludedRemainder = await findings('excluded', `&offset=2&limit=2&expectedFingerprint=${excludedPage.fingerprint}`);
  assert.equal(excludedRemainder.fingerprint, excludedPage.fingerprint);
  const excluded = [...excludedPage.rows, ...excludedRemainder.rows];
  assert.deepEqual(new Set(excluded.map(row => row.sourceId)), new Set(['503', '505', '506']));
  for (const row of excluded) {
    const archived = await f.call<SourceRecordArchive>(`/source-imports/${receipt.id}/records/${row.sourceRecordId}`);
    assert.equal(archived.record.sourceId, row.sourceId);
    assert.deepEqual(row, { sourceRecordId: archived.id, sourceId: archived.record.sourceId, sourceInstance, sourceIssueId: '4401', changeCount: 1, reason: null });
  }
  const unknownTime = await findings('unresolved-time');
  assert.equal(unknownTime.limit, 30);
  assert.equal(unknownTime.totalChanges, initialSummary.unresolvedTime);
  assert.deepEqual(unknownTime.rows, [{ sourceRecordId: unresolved.sourceRecordId, sourceId: '502', sourceInstance,
    sourceIssueId: '4401', changeCount: 1, reason: null }]);
  for (const query of [
    `?expectedVersion=${receipt.version}`,
    '?finding=excluded',
    `?expectedVersion=${receipt.version}&finding=duplicate`,
    ...['&limit=101', '&limit=0', '&offset=-1', '&offset=1000001', '&finding=restricted', '&expectedFingerprint=bad', '&extra=1']
      .map(invalid => `?expectedVersion=${receipt.version}&finding=excluded${invalid}`),
  ]) await f.call(findingsPath + query, 'GET', undefined, 400);
  await f.call(`${findingsPath}?expectedVersion=${receipt.version + 1}&finding=excluded`, 'GET', undefined, 409);
  await f.call(`${findingsPath}?expectedVersion=${receipt.version}&finding=excluded&expectedFingerprint=${'0'.repeat(64)}`, 'GET', undefined, 409);

  // Older receipts could still carry an owner link before scoped history filtering was introduced.
  const db = new DatabaseSync(join(f.dataDir, 'teamspace.sqlite'));
  try {
    const attachLegacy = db.prepare(`UPDATE source_records SET owner_type='issue',owner_id=?,json=json_set(json_remove(json,'$.excluded'),'$.ownerType','issue','$.ownerId',?)
      WHERE import_id=? AND kind='history' AND source_id=?`);
    for (const group of ['503', '506']) attachLegacy.run(issue.id, issue.id, receipt.id, group);
    const origins = await f.call<SourceRecordPage>(`/resource-origins?resourceType=issue&resourceId=${issue.id}&kind=history`);
    assert.ok(!origins.records.some(record => record.record.sourceId === '506'));
    assert.equal((await page()).total, 2);
    assert.deepEqual((await audit(receipt)).jiraStatusHistory, initialSummary, 'reviewed receipt exclusions still count when a legacy row lacks a flag');
    const receiptRow = db.prepare('SELECT json FROM source_imports WHERE id=?').get(receipt.id);
    assert.ok(typeof receiptRow?.json === 'string');
    const reviewedExclusions = receipt.configuration.excludedRecords.filter(key => key !== `${initial.pkg.id}/history:506`);
    db.prepare("UPDATE source_imports SET json=json_set(json,'$.configuration.excludedRecords',json(?)) WHERE id=?")
      .run(JSON.stringify(reviewedExclusions), receipt.id);
    const restricted = (await audit(receipt)).jiraStatusHistory;
    assert.deepEqual(restricted, { ...initialSummary, excluded: 2, restricted: 1 });
    assert.doesNotMatch(JSON.stringify(restricted), /원본 작성자|보관된 상태 이름|동일 그룹의 제한|시각 보류|18\/Jan\/25/);
    const restrictedFindings = await findings('restricted');
    assert.equal(restrictedFindings.totalChanges, restricted.restricted);
    assert.deepEqual(restrictedFindings.rows.map(({ sourceId, changeCount, reason }) => ({ sourceId, changeCount, reason })), [
      { sourceId: '506', changeCount: 1, reason: null },
    ]);
    assert.doesNotMatch(JSON.stringify(restrictedFindings), /원본 작성자|동일 그룹의 제한|같은 그룹의 제한된 항목/);
    db.prepare('UPDATE source_imports SET json=? WHERE id=?').run(receiptRow.json, receipt.id);
    const restoreExclusion = db.prepare(`UPDATE source_records SET owner_type=NULL,owner_id=NULL,json=json_set(json,'$.ownerType',NULL,'$.ownerId',NULL,'$.excluded',json('true'))
      WHERE import_id=? AND kind='history' AND source_id=?`);
    for (const group of ['503', '506']) restoreExclusion.run(receipt.id, group);
    assert.ok(original.record.authorId);
    const identity = db.prepare("SELECT id,json FROM source_records WHERE import_id=? AND kind='identity' AND source_id=?")
      .get(receipt.id, original.record.authorId);
    assert.ok(typeof identity?.id === 'string' && typeof identity.json === 'string');
    db.prepare("UPDATE source_records SET json=json_set(json,'$.excluded',json('true')) WHERE id=?").run(identity.id);
    assert.equal((await page()).entries[0].originalAuthorName, null);
    const withoutAuthor = (await audit(receipt)).jiraStatusHistory;
    assert.equal(withoutAuthor?.unresolvedAuthor, 2);
    assert.notEqual(withoutAuthor?.projected.sha256, initialSummary.projected.sha256);
    const missingAuthor = await findings('unresolved-author');
    assert.equal(missingAuthor.totalChanges, withoutAuthor.unresolvedAuthor);
    assert.deepEqual(new Set(missingAuthor.rows.map(row => row.sourceId)), new Set(['501', '502']));
    db.prepare('UPDATE source_records SET json=? WHERE id=?').run(identity.json, identity.id);
    assert.equal((await findings('unresolved-author')).totalChanges, 0);

    const unresolvedArchive = await f.call<SourceRecordArchive>(`/source-imports/${receipt.id}/records/${unresolved.sourceRecordId}`);
    db.prepare("UPDATE source_records SET json=json_insert(json,'$.record.metadata.items[#]',json(?)) WHERE id=?")
      .run(JSON.stringify(restStatus('3', '추가 검토', '2', '업무 조정')), unresolvedArchive.id);
    const combinedGroup = await findings('unresolved-time');
    assert.equal(combinedGroup.total, 1);
    assert.equal(combinedGroup.totalChanges, 2);
    assert.deepEqual(combinedGroup.rows, [{ ...unknownTime.rows[0], changeCount: 2 }]);
    assert.notEqual(combinedGroup.fingerprint, unknownTime.fingerprint);
    db.prepare('UPDATE source_records SET json=? WHERE id=?').run(JSON.stringify(unresolvedArchive), unresolvedArchive.id);

    // A live issue in the archived owner column still needs original alias proof.
    const updateOriginal = db.prepare('UPDATE source_records SET json=? WHERE id=?');
    updateOriginal.run(JSON.stringify({ ...original, record: { ...original.record,
      references: original.record.references.map(reference => reference.relation === 'historyOf' ? { ...reference, sourceId: 'unknown-issue' } : reference),
    } }), original.id);
    const unverifiedOwner = await findings('unavailable');
    assert.equal(unverifiedOwner.totalChanges, 1);
    assert.deepEqual(unverifiedOwner.rows, [{ sourceRecordId: original.id, sourceId: '501', sourceInstance, sourceIssueId: '4401', changeCount: 1,
      reason: 'ownership-unverified' }]);
    updateOriginal.run(JSON.stringify(original), original.id);
  } finally {
    db.close();
  }

  const api = await f.call<ApiKeyCreated>('/api-keys', 'POST', { name: 'migration history test', projectIds: [projectId], access: 'read', expiresAt: null }, 201);
  await f.call(`/v1${history}`, 'GET', undefined, 403, { Authorization: `Bearer ${api.token}` });
  await f.call(`/v1${findingsPath}?expectedVersion=${receipt.version}&finding=unavailable`, 'GET', undefined, 403, { Authorization: `Bearer ${api.token}` });
  const deleted = await f.call<{ trashEntryId: string }>(`/issues/${issue.id}`, 'DELETE', { expectedVersion: issue.version });
  await f.call(history, 'GET', undefined, 404);
  const trashedSummary = (await audit(receipt)).jiraStatusHistory;
  assert.ok(trashedSummary);
  assert.deepEqual(trashedSummary, {
    ...initialSummary, projected: { count: 0, sha256: trashedSummary.projected.sha256 }, unavailable: 2, unresolvedTime: 0,
  });
  assert.notEqual(trashedSummary.projected.sha256, initialSummary.projected.sha256);
  const trashedFindings = await findings('unavailable', '&limit=1');
  assert.equal(trashedFindings.total, 2);
  assert.equal(trashedFindings.totalChanges, trashedSummary.unavailable);
  assert.equal(trashedFindings.rows[0]?.reason, 'issue-in-trash');
  assert.doesNotMatch(JSON.stringify(trashedFindings), /원본 작성자|보관된 상태 이름|2025-01-03/);
  await f.call(`/trash/${deleted.trashEntryId}/restore`, 'POST', {});
  await f.call(`${findingsPath}?expectedVersion=${receipt.version}&finding=unavailable&offset=1&limit=1&expectedFingerprint=${trashedFindings.fingerprint}`,
    'GET', undefined, 409);
  assert.equal((await findings('unavailable')).total, 0);
  assert.deepEqual(await page('?limit=1'), first);
  assert.deepEqual((await audit(receipt)).jiraStatusHistory, initialSummary);

  const additional = await f.options('jira-rest.zip', restPackage());
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
  const appendedAudit = await audit(append);
  const appendedSummary = appendedAudit.jiraStatusHistory;
  assert.ok(appendedSummary);
  assert.match(appendedSummary.projected.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(appendedSummary, {
    sourceChanges: 3, projected: { count: 1, sha256: appendedSummary.projected.sha256 }, duplicate: 1,
    excluded: 1, restricted: 0, unavailable: 0, unresolvedTime: 0, unresolvedAuthor: 0,
  });
  assert.equal(appendedSummary.projected.count, combined.entries.filter(change => change.sourceImportId === append.id).length);
  assert.doesNotMatch(JSON.stringify(appendedSummary), /종료 기록|제한된 REST 이력|원본 작성자/);

  const attachment = appendedAudit.attachments.find(file => file.status === 'verified');
  assert.ok(attachment?.fileId);
  const updates = new DatabaseSync(join(f.dataDir, 'teamspace.sqlite'));
  try {
    const oldGroup = updates.prepare('SELECT json FROM source_records WHERE id=?').get(entry.sourceRecordId);
    assert.ok(typeof oldGroup?.json === 'string');
    const originalJson = oldGroup.json;
    const open = fileSystem.open;
    let changed = false;
    // The live duplicate comes from an earlier receipt, outside the attachment audit's own archive.
    const concurrentChange = t.mock.method(fileSystem, 'open', async (...args: Parameters<typeof open>) => {
      if (!changed && String(args[0]) === join(f.dataDir, 'uploads', attachment.fileId!)) {
        changed = true;
        assert.equal(updates.prepare("UPDATE source_records SET json=json_set(json,'$.record.metadata.items[0].field','summary') WHERE id=?")
          .run(entry.sourceRecordId).changes, 1);
      }
      return open(...args);
    });
    try {
      await f.call(auditPath(append), 'GET', undefined, 409);
      assert.equal(changed, true);
    } finally { concurrentChange.mock.restore(); }
    const after = await audit(append);
    assert.deepEqual(after.integrity, appendedAudit.integrity);
    assert.deepEqual(after.recordCounts, appendedAudit.recordCounts);
    assert.deepEqual(after.targetContent, appendedAudit.targetContent);
    assert.equal(after.jiraStatusHistory?.duplicate, 0);
    assert.equal(after.jiraStatusHistory?.projected.count, 2);
    assert.notEqual(after.jiraStatusHistory?.projected.sha256, appendedSummary.projected.sha256);
    assert.equal(updates.prepare('UPDATE source_records SET json=? WHERE id=?').run(originalJson, entry.sourceRecordId).changes, 1);
  } finally { updates.close(); }

  const beforeMove = await workspace();
  const moveTarget = beforeMove.projects.find(value => value.id !== projectId)!;
  const moveInput = { expectedVersion: beforeMove.issues.find(value => value.id === issue.id)!.version,
    projectId: moveTarget.id, includeConnected: false, mappings: [{ issueId: issue.id, type: '작업', status: 'todo' }] };
  const movePath = `/issues/${issue.id}/project-move`;
  const movePreview = await f.call<IssueProjectMovePreview>(`${movePath}/preview`, 'POST', moveInput);
  assert.ok(movePreview.token, JSON.stringify(movePreview.blockers));
  const move = await f.call<IssueProjectMoveResult>(`${movePath}/apply`, 'POST', { ...moveInput, token: movePreview.token });
  assert.deepEqual(move.issues.map(({ id, projectId }) => [id, projectId]), [[issue.id, moveTarget.id]]);
  assert.deepEqual(await page(), combined);
  assert.deepEqual((await audit(receipt)).jiraStatusHistory, initialSummary);
  assert.deepEqual((await audit(append)).jiraStatusHistory, appendedSummary);

  const postMove = await f.options('jira-rest-after-move.zip', restPackage(true));
  assert.equal(postMove.appendTarget?.projectId, projectId);
  const ignored = await f.apply({ ...postMove.defaultConfiguration, timezone: 'Asia/Seoul',
    excludedRecords: [`${postMove.pkg.id}/history:602`], appendTo: { projectId,
      statuses: Object.fromEntries(postMove.statuses.map(value => [value.id, target.statuses.find(state => state.label === value.label)!.id])),
      issueTypes: Object.fromEntries(postMove.issueTypes.map(value => [value.id, target.issueTypes.find(type => type.name === value.label)!.id])),
      fields: {},
    } });
  assert.deepEqual(await page(), combined);
  const ignoredFindings = await f.call<SourceReconciliationJiraStatusFindingsPage>(
    `/source-imports/${ignored.id}/reconciliation/jira-status-findings?expectedVersion=${ignored.version}&finding=unavailable`);
  assert.ok(ignoredFindings.rows.some(row => row.sourceId === '603' && row.reason === 'ownership-unverified'));

  const backup = await f.call('/export');
  await f.call('/import', 'POST', { data: backup });
  const receipts = await f.call<SourceImport[]>('/source-imports');
  const restoredReceipt = receipts.find(value => value.id === receipt.id)!;
  assert.deepEqual(await page(), combined);
  assert.deepEqual((await audit(restoredReceipt)).jiraStatusHistory, initialSummary);
  assert.deepEqual((await audit(receipts.find(value => value.id === append.id)!)).jiraStatusHistory, appendedSummary);
  const currentIssue = (await workspace()).issues.find(value => value.id === issue.id)!;
  const removed = await f.call<{ trashEntryId: string }>(`/issues/${issue.id}`, 'DELETE', { expectedVersion: currentIssue.version });
  const restoredAppend = receipts.find(value => value.id === append.id)!;
  const appendedFindingsPath = `/source-imports/${append.id}/reconciliation/jira-status-findings?expectedVersion=${restoredAppend.version}&finding=unavailable`;
  const afterMoveTrash = await f.call<SourceReconciliationJiraStatusFindingsPage>(appendedFindingsPath);
  assert.equal(afterMoveTrash.totalChanges, 2);
  assert.deepEqual(afterMoveTrash.rows.map(row => row.reason), ['issue-in-trash', 'issue-in-trash']);
  await f.call(`/trash/${removed.trashEntryId}`, 'DELETE');
  const unavailable = await f.call<SourceReconciliationJiraStatusFindingsPage>(
    `${findingsPath}?expectedVersion=${restoredReceipt.version}&finding=unavailable`);
  assert.equal(unavailable.totalChanges, 2);
  assert.deepEqual(unavailable.rows.map(row => row.reason), ['issue-unavailable', 'issue-unavailable']);
  const afterMovePurge = await f.call<SourceReconciliationJiraStatusFindingsPage>(appendedFindingsPath);
  assert.equal(afterMovePurge.totalChanges, 2);
  assert.deepEqual(afterMovePurge.rows.map(row => row.reason), ['issue-unavailable', 'issue-unavailable']);
});
