import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import fileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { zip } from '../fixtures/legacy-export-zip.mjs';
import type { ApiKeyCreated, Attachment, AttachmentHead, AttachmentVersion, DocPage, LegacyPackageSummary, MigrationApplyResult, MigrationConfiguration, MigrationOptions, MigrationPreview, SourceImport, SourceReconciliationAudit, SourceReconciliationFileCheck, SourceReconciliationPage, SourceRecordArchive, SourceRecordPage, WebhookEndpointCreated, WorkspaceSnapshot } from '../../shared/types.js';
import { createApp } from '../../server/app.js';
import { AttachmentAppend, type AppendedFile } from '../../server/attachment-append.js';
import { hash } from '../../server/attachments.js';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'teamspace-migration-integration-')), service = createApp({ dataDir: dir, outboundWorker: false }), server = service.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}/api`, db = new DatabaseSync(join(dir, 'teamspace.sqlite')); db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
  async function call<T = unknown>(path: string, method = 'GET', body?: unknown, actor = 'user-seo') { const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': actor }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json() as T }; }
  async function upload(bytes: Buffer, filename: string, product = 'auto') { const params = new URLSearchParams({ filename, product, instanceKey: `synthetic-${randomUUID()}` }); const response = await fetch(`${base}/legacy-import/packages?${params}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': 'user-seo' }, body: new Uint8Array(bytes) }); const data = await response.json() as LegacyPackageSummary; assert.equal(response.status, 201, JSON.stringify(data)); return data; }
  async function configuration(pkg: LegacyPackageSummary, key = `MIG${randomUUID().replaceAll('-', '').slice(0, 7).toUpperCase()}`) {
    const result = await call<MigrationOptions>(`/migrations/options?packageId=${pkg.id}`); assert.equal(result.status, 200);
    const config = result.data.defaultConfiguration; config.projects = config.projects.map(value => ({ ...value, key, name: 'Synthetic unified migration' })); config.datePolicy = 'import-time'; for (const identity of result.data.identities) config.users[identity.id] = 'user-jun'; return config;
  }
  async function preview(configuration: MigrationConfiguration) { const result = await call<MigrationPreview>('/migrations/preview', 'POST', { configuration }); assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data; }
  async function apply(plan: MigrationPreview, extra: Record<string, unknown> = {}, actor = 'user-seo') { return call<MigrationApplyResult>(`/migrations/previews/${plan.id}/apply`, 'POST', { expectedVersion: plan.version, acknowledgements: plan.requiredAcknowledgements, ...extra }, actor); }
  return { dir, base, db, call, upload, configuration, preview, apply, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); service.close(); db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const csv = Buffer.from('Issue id,Issue key,Project key,Summary,Description,Reporter,Created,Updated,Status,Issue Type,Comment\r\n100,OLD-1,OLD,Synthetic imported issue one,"h2. 원본 설명",original.author,2020-01-01T00:00:00Z,2020-01-02T00:00:00Z,Open,Task,"2020-01-03T00:00:00Z;original.author;보존한 댓글"\r\n200,OTHER-1,OTHER,Synthetic imported issue two,두번째 설명,original.author,2020-01-01T00:00:00Z,2020-01-02T00:00:00Z,Open,Task,\r\n');
function confluence(withAuditFixtures = false) {
  const first = Buffer.from('첫 버전\r\n\x00바이너리'), latest = Buffer.from('두 번째 버전😀\r\n원본');
  const prop = (name: string, text: string) => `<property name="${name}">${text}</property>`, ref = (name: string, type: string, id: string) => `<property name="${name}" class="${type}"><id name="id">${id}</id></property>`, object = (type: string, id: string, text: string) => `<object class="${type}"><id name="id">${id}</id>${text}</object>`;
  const historical = withAuditFixtures ? '<collection name="historicalVersions"><element class="Page"><id name="id">101</id></element></collection>' : '';
  const extra = withAuditFixtures ? [
    object('Page', '101', prop('title', 'Synthetic historical page') + prop('version', '1') + prop('contentStatus', 'historical') + ref('originalVersion', 'Page', '100') + ref('space', 'Space', '42')),
    object('BodyContent', '301', '<property name="body"><![CDATA[<p>보존한 이전 본문</p>]]></property>' + ref('content', 'Page', '101')),
    object('Comment', '400', ref('containerContent', 'Page', '100') + prop('creationDate', '2020-01-03T00:00:00Z')),
    object('BodyContent', '401', '<property name="body"><![CDATA[<p>보존한 원본 댓글</p>]]></property>' + ref('content', 'Comment', '400')),
    ...[['702', 'removed-before-trash.txt'], ['703', 'source-metadata-only.txt'], ['704', 'intentionally-excluded.txt']].map(([id, filename]) =>
      object('Attachment', id, prop('title', filename) + prop('version', '1') + ref('containerContent', 'Page', '100') + prop('creationDate', '2020-01-02T00:00:00Z'))),
  ].join('') : '';
  const xml = `<hibernate-generic>${object('Space', '42', prop('key', 'SYN') + prop('name', 'Synthetic archive'))}${object('Page', '100', prop('title', 'Synthetic versioned page') + prop('version', withAuditFixtures ? '2' : '1') + ref('space', 'Space', '42') + prop('creationDate', '2020-01-01T00:00:00Z') + prop('lastModificationDate', '2020-01-02T00:00:00Z') + historical)}${object('BodyContent', '300', '<property name="body"><![CDATA[<p>보존한 문서 본문</p>]]></property>' + ref('content', 'Page', '100'))}${object('Attachment', '700', prop('title', 'report.bin') + prop('version', '2') + ref('containerContent', 'Page', '100') + '<collection name="historicalVersions"><element class="Attachment"><id name="id">701</id></element></collection>' + prop('creationDate', '2020-01-02T00:00:00Z'))}${object('Attachment', '701', prop('title', 'report.bin') + prop('version', '1') + ref('containerContent', 'Page', '100') + ref('originalVersion', 'Attachment', '700') + prop('creationDate', '2020-01-01T00:00:00Z'))}${extra}</hibernate-generic>`;
  const entries = [{ path: 'entities.xml', bytes: Buffer.from(xml) }, { path: 'attachments/100/700/1', bytes: first }, { path: 'attachments/100/700/2', bytes: latest }];
  if (withAuditFixtures) entries.push(
    { path: 'attachments/100/702/1', bytes: Buffer.from('삭제 전 독립 첨부') },
    { path: 'attachments/100/704/1', bytes: Buffer.from('의도적으로 이관에서 제외한 바이너리') },
  );
  return { first, latest, bytes: zip(entries) };
}

test('actual HTTP worker merges source containers into a new project, enforces review/actor/server IDs, rejects conflicts and suppresses outbound import events', async () => {
  const f = await fixture(); try {
    const endpoint = await f.call<WebhookEndpointCreated>('/webhook-endpoints', 'POST', { name: 'Synthetic no-network outbox', url: 'http://127.0.0.1:1/not-called', projectIds: null, eventTypes: ['issue.created', 'comment.created'] }); assert.equal(endpoint.status, 201); assert.equal((await f.call(`/webhook-endpoints/${endpoint.data.endpoint.id}`, 'PATCH', { expectedVersion: 1, enabled: true })).status, 200);
    const pkg = await f.upload(csv, 'migration.csv'), config = await f.configuration(pkg); assert.equal(config.projects.length, 2);
    assert.equal((await f.call('/migrations/preview', 'POST', { configuration: config }, 'missing-actor')).status, 400);
    const bad = structuredClone(config); bad.users[Object.keys(bad.users)[0]] = 'missing-user'; const blocked = await f.preview(bad); assert.equal(blocked.canApply, false); assert.equal((await f.apply(blocked)).status, 409);
    const plan = await f.preview(config); assert.equal(plan.canApply, true, JSON.stringify(plan.notices)); assert.equal(plan.projects.length, 1); assert.ok(plan.requiredAcknowledgements.length > 0);
    assert.equal((await f.apply(plan, {}, 'user-min')).status, 403); assert.equal((await f.apply(plan, { expectedVersion: 99 })).status, 409); assert.equal((await f.apply(plan, { acknowledgements: [] })).status, 400);
    const conflictConfig = structuredClone(config); conflictConfig.projects = conflictConfig.projects.map(value => ({ ...value, key: 'CONFLICT' })); const conflict = await f.preview(conflictConfig); assert.equal(conflict.canApply, true);
    assert.equal((await f.call('/projects', 'POST', { key: 'CONFLICT', name: 'Synthetic competing project' })).status, 201); assert.equal((await f.apply(conflict)).status, 409);
    const before = (await f.call<WorkspaceSnapshot>('/workspace')).data;
    const applied = await f.apply(plan, { actorId: 'user-min', projects: [{ id: 'client-forged-project' }], issues: [{ id: 'client-forged-issue', title: 'forged' }] }); assert.equal(applied.status, 201, JSON.stringify(applied.data)); assert.equal(applied.data.duplicate, false); assert.equal(applied.data.import.actorId, 'user-seo'); assert.deepEqual(applied.data.import.notices, plan.notices);
    const after = (await f.call<WorkspaceSnapshot>('/workspace')).data, imported = after.issues.filter(value => applied.data.import.projectIds.includes(value.projectId)); assert.equal(after.projects.length, before.projects.length + 1); assert.equal(imported.length, 2); assert.ok(imported.every(value => /^[a-f\d-]{36}$/.test(value.id) && !value.id.startsWith('client-'))); assert.ok(!after.projects.some(value => value.id === 'client-forged-project'));
    const receipt = (await f.call<SourceImport[]>('/source-imports')).data[0]; assert.deepEqual(receipt.notices, plan.notices); const originals = (await f.call<SourceRecordPage>(`/source-imports/${plan.id}/records?kind=issue`)).data; assert.equal(originals.total, 2); assert.deepEqual(originals.records.map(value => value.record.sourceId).sort(), ['100', '200']);
    const duplicate = await f.apply(plan); assert.equal(duplicate.status, 200); assert.equal(duplicate.data.duplicate, true); assert.equal((await f.call<WorkspaceSnapshot>('/workspace')).data.issues.length, after.issues.length);
    const repeatedConfig = structuredClone(config); repeatedConfig.projects = repeatedConfig.projects.map(value => ({ ...value, key: 'SECOND' })); const repeated = await f.preview(repeatedConfig); assert.equal(repeated.canApply, false); assert.ok(repeated.notices.some(value => value.code === 'SOURCE_ALREADY_IMPORTED' && value.severity === 'error')); assert.equal((await f.apply(repeated)).status, 409); assert.equal((await f.call<SourceImport[]>('/source-imports')).data.length, 1); assert.deepEqual((await f.call('/webhook-deliveries')).data, []);
  } finally { await f.close(); }
});

test('actual ZIP attachment versions survive native9 exact downloads and migration audit/save/install failures roll back database and files', async t => {
  const f = await fixture(), binary = confluence(); try {
    const pkg = await f.upload(binary.bytes, 'confluence.zip', 'confluence'), config = await f.configuration(pkg), plan = await f.preview(config); assert.equal(plan.canApply, true, JSON.stringify(plan.notices)); assert.equal(plan.counts.attachmentVersions, 2);
    const existingBytes = Buffer.from('unrelated existing fixture file'), upload = await fetch(`${f.base}/attachments?resourceType=issue&resourceId=issue-2&filename=existing.bin`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': 'user-seo' }, body: existingBytes }); assert.equal(upload.status, 201); const existing = await upload.json() as Attachment;
    const before = (await f.call<WorkspaceSnapshot>('/workspace')).data, names = readdirSync(join(f.dir, 'uploads')).sort();
    const unchanged = async () => { assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).data, before); assert.deepEqual((await f.call('/source-imports')).data, []); assert.deepEqual(readdirSync(join(f.dir, 'uploads')).sort(), names); assert.deepEqual(readFileSync(join(f.dir, 'uploads', existing.id)), existingBytes); assert.ok(!readdirSync(f.dir).some(value => value.startsWith('.append-'))); };
    f.db.exec("CREATE TRIGGER synthetic_migration_audit BEFORE INSERT ON activities WHEN json_extract(NEW.json,'$.action')='원본 이관 적용' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;");
    assert.equal((await f.apply(plan)).status, 500); f.db.exec('DROP TRIGGER synthetic_migration_audit'); await unchanged();
    f.db.exec("CREATE TRIGGER synthetic_migration_save BEFORE INSERT ON documents WHEN json_extract(NEW.json,'$.title')='Synthetic versioned page' BEGIN SELECT RAISE(ABORT,'synthetic save failure'); END;");
    assert.equal((await f.apply(plan)).status, 500); f.db.exec('DROP TRIGGER synthetic_migration_save'); await unchanged();
    const stage = AttachmentAppend.prototype.stage;
    const installedFailure = t.mock.method(AttachmentAppend.prototype, 'stage', function (this: AttachmentAppend, id: string, files: AppendedFile[]) { const result = stage.call(this, id, files); return { ...result, install() { result.install(); throw new Error('synthetic failure after install'); } }; });
    assert.equal((await f.apply(plan)).status, 500); installedFailure.mock.restore(); await unchanged();
    const applied = await f.apply(plan); assert.equal(applied.status, 201, JSON.stringify(applied.data));
    const workspace = (await f.call<WorkspaceSnapshot>('/workspace')).data, document = workspace.documents.find(value => applied.data.import.projectIds.includes(value.projectId || ''))!; assert.ok(document);
    const files = (await f.call<Attachment[]>(`/attachments?resourceType=document&resourceId=${document.id}`)).data; assert.equal(files.length, 1); const versions = (await f.call<AttachmentVersion[]>(`/attachments/${files[0].id}/versions`)).data; assert.equal(versions.length, 2);
    async function exactDownloads() { for (const version of versions) { const response = await fetch(`${f.base}/attachment-versions/${version.id}/download`); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'application/octet-stream'); assert.deepEqual(Buffer.from(await response.arrayBuffer()), version.versionLabel === '1' ? binary.first : binary.latest); } }
    await exactDownloads();
    const backup = (await f.call<Record<string, unknown>>('/export')).data; assert.equal(backup.schemaVersion, 26); assert.equal((backup.attachmentVersions as unknown[]).length, 2); assert.equal((backup.attachmentContents as unknown[]).length, 3);
    const invalidNotice = structuredClone(backup); (invalidNotice.sourceImports as SourceImport[])[0].notices = [{ severity: 'error', code: 'SYNTHETIC_BLOCKER', message: '완료된 영수증에 오류를 넣을 수 없음', recordId: null, requiresAcknowledgement: false }]; assert.equal((await f.call('/import', 'POST', { data: invalidNotice })).status, 400); await exactDownloads();
    const invalid = structuredClone(backup); (invalid.resourceLinks as { documentId: string }[])[0].documentId = 'synthetic-missing-document'; const snapshot = (await f.call<WorkspaceSnapshot>('/workspace')).data;
    assert.equal((await f.call('/import', 'POST', { data: invalid })).status, 404); assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).data, snapshot); await exactDownloads();
    assert.equal((await f.call('/import', 'POST', { data: backup })).status, 200); await exactDownloads();
    const after = (await f.call<SourceImport[]>('/source-imports')).data[0]; assert.equal(after.version, 2); assert.deepEqual(after.notices, plan.notices);
    const archives = (await f.call<SourceRecordPage>(`/source-imports/${plan.id}/records?kind=attachment`)).data; assert.equal(archives.total, 2); const archive = (await f.call<SourceRecordArchive>(`/source-imports/${plan.id}/records/${archives.records[0].id}`)).data; assert.equal(archive.record.kind, 'attachment');

    const root = files[0].id;
    const localBytes = Buffer.from('현지 팀에서 추가한 합성 버전');
    const localUpload = await fetch(`${f.base}/attachments/${root}/versions?${new URLSearchParams({ expectedVersionId: root, filename: 'updated.bin' })}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': 'user-min' }, body: new Uint8Array(localBytes),
    });
    const local = await localUpload.json() as AttachmentHead;
    assert.equal(localUpload.status, 201, JSON.stringify(local));
    assert.equal(local.id, root);
    assert.notEqual(local.currentVersionId, root);
    assert.equal(local.versionCount, 3);
    const historyWithLocal = (await f.call<AttachmentVersion[]>(`/attachments/${root}/versions`)).data;
    assert.equal(historyWithLocal[0].id, local.currentVersionId);
    assert.equal(historyWithLocal[0].localRevision, 2);
    assert.equal(historyWithLocal[0].sourceImportId, null);
    assert.deepEqual(historyWithLocal.slice(1), versions);
    const preservedRoot = await fetch(`${f.base}/attachments/${root}/content`);
    assert.equal(preservedRoot.status, 200);
    assert.deepEqual(Buffer.from(await preservedRoot.arrayBuffer()), binary.latest);
    await exactDownloads();

    const withLocal = (await f.call<Record<string, unknown>>('/export')).data;
    assert.equal((await f.call('/import', 'POST', { data: withLocal })).status, 200);
    assert.deepEqual((await f.call<AttachmentVersion[]>(`/attachments/${root}/versions`)).data, historyWithLocal);
    assert.deepEqual((await f.call<SourceRecordPage>(`/source-imports/${plan.id}/records?kind=attachment`)).data, archives);
    const localBytesAgain = await fetch(`${f.base}/attachments/${local.currentVersionId}/content`);
    assert.equal(localBytesAgain.status, 200);
    assert.deepEqual(Buffer.from(await localBytesAgain.arrayBuffer()), localBytes);
    await exactDownloads();
  } finally { await f.close(); }
});

test('reconciliation and the whole-receipt audit follow exact migrated attachment versions through corruption, trash, native restore, and deletion', async t => {
  const f = await fixture(), binary = confluence(true);
  try {
    const pkg = await f.upload(binary.bytes, 'reconciliation.zip', 'confluence');
    const config = await f.configuration(pkg);
    config.excludedRecords = [`${pkg.id}/attachment:704`];
    const plan = await f.preview(config);
    assert.equal(plan.canApply, true, JSON.stringify(plan.notices));
    const applied = await f.apply(plan);
    assert.equal(applied.status, 201, JSON.stringify(applied.data));
    const receipt = applied.data.import;
    const auditPath = `/source-imports/${receipt.id}/reconciliation`;
    const fullPath = (version = receipt.version) => `${auditPath}/audit?expectedVersion=${version}`;
    async function audit(query = '') {
      const result = await f.call<SourceReconciliationPage>(auditPath + query);
      assert.equal(result.status, 200, JSON.stringify(result.data));
      assert.equal(result.data.importId, receipt.id);
      return result.data;
    }
    async function fullAudit(version = receipt.version) {
      const result = await f.call<SourceReconciliationAudit>(fullPath(version));
      assert.equal(result.status, 200, JSON.stringify(result.data));
      assert.equal(result.data.importId, receipt.id);
      assert.equal(result.data.receiptVersion, version);
      assert.ok(Date.parse(result.data.startedAt) <= Date.parse(result.data.completedAt));
      assert.equal(result.data.attachments.length, Object.values(result.data.attachmentCounts).reduce((sum, count) => sum + count, 0));
      return result.data;
    }
    const initial = await audit();
    assert.equal(initial.receiptVersion, receipt.version);
    assert.equal(initial.total, receipt.counts.sourceRecords);
    assert.equal(initial.total, Object.values(initial.counts).reduce((sum, count) => sum + count, 0));
    assert.doesNotMatch(JSON.stringify(initial), /보존한 문서 본문|보존한 원본 댓글/);

    const document = initial.rows.find(row => row.kind === 'page');
    const related = initial.rows.filter(row => row.kind === 'revision' || row.kind === 'comment');
    const versionRows = initial.rows.filter(row => row.kind === 'attachment');
    const older = versionRows.find(row => row.sourceId === '701');
    const newer = versionRows.find(row => row.sourceId === '700');
    const removed = versionRows.find(row => row.sourceId === '702');
    const archiveOnly = versionRows.find(row => row.sourceId === '703');
    const excluded = versionRows.find(row => row.sourceId === '704');
    assert.ok(document?.target && older?.target && newer?.target && removed?.target && archiveOnly && excluded);
    const documentId = document.target.id;
    const archivedTogether = [document, older, newer, ...related];
    assert.deepEqual(related.map(row => row.kind).sort(), ['comment', 'revision']);
    assert.ok(archivedTogether.every(row => row.status === 'linked'));
    assert.ok([older, newer, removed, ...related].every(row => row.target?.owner?.id === documentId));
    assert.equal(archiveOnly.status, 'archive-only');
    assert.equal(archiveOnly.target, null);

    const checkFilePath = (sourceRecordId: string) => `/source-imports/${receipt.id}/records/${sourceRecordId}/check-file`;
    async function checkFile(sourceRecordId: string) {
      const checked = await f.call<SourceReconciliationFileCheck>(checkFilePath(sourceRecordId));
      assert.equal(checked.status, 200, JSON.stringify(checked.data));
      assert.equal(checked.data.sourceRecordId, sourceRecordId);
      return checked.data;
    }
    assert.equal((await f.call(checkFilePath(document.sourceRecordId))).status, 400);
    assert.equal((await checkFile(archiveOnly.sourceRecordId)).status, 'unbound');
    const expectedOlder = { sourceRecordId: older.sourceRecordId, status: 'verified', fileId: older.target.id, size: binary.first.length, sha256: hash(binary.first) };
    assert.deepEqual(await checkFile(older.sourceRecordId), expectedOlder);
    assert.equal((await checkFile(newer.sourceRecordId)).sha256, hash(binary.latest));

    assert.equal(excluded.status, 'excluded');
    const untouchedWorkspace = (await f.call<WorkspaceSnapshot>('/workspace')).data;
    const clean = await fullAudit();
    const cleanOlder = clean.attachments.find(row => row.sourceRecordId === older.sourceRecordId);
    assert.deepEqual(clean.recordCounts, initial.counts);
    assert.deepEqual(clean.attachmentCounts, { verified: 3, missing: 0, corrupt: 0, unbound: 1, excluded: 1, unreadable: 0 });
    assert.deepEqual(cleanOlder, {
      ...expectedOlder, sourceId: '701', title: 'report.bin', product: 'confluence', recordStatus: 'linked',
      sourceInstance: pkg.source.instanceKey, packageSha256: pkg.sha256,
    });
    assert.equal(clean.attachments.find(row => row.sourceRecordId === newer.sourceRecordId)?.sha256, hash(binary.latest));
    assert.equal(clean.attachments.find(row => row.sourceRecordId === excluded.sourceRecordId)?.status, 'excluded');
    assert.equal(clean.attachments.find(row => row.sourceRecordId === archiveOnly.sourceRecordId)?.status, 'unbound');
    assert.doesNotMatch(JSON.stringify(clean), /보존한 문서 본문|보존한 원본 댓글/);
    assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).data, untouchedWorkspace);
    assert.deepEqual((await f.call<SourceImport[]>('/source-imports')).data.find(value => value.id === receipt.id), receipt);

    const olderPath = join(f.dir, 'uploads', older.target.id);
    const corrupted = Buffer.from(binary.first);
    corrupted[0] ^= 1;
    try {
      writeFileSync(olderPath, corrupted);
      assert.deepEqual(await checkFile(older.sourceRecordId), { ...expectedOlder, status: 'corrupt' });
      const mixed = await fullAudit();
      assert.deepEqual(mixed.attachmentCounts, { ...clean.attachmentCounts, verified: 2, corrupt: 1 });
      assert.equal(mixed.attachments.find(row => row.sourceRecordId === older.sourceRecordId)?.recordStatus, 'linked');
      rmSync(olderPath);
      assert.deepEqual(await checkFile(older.sourceRecordId), { ...expectedOlder, status: 'missing' });
      assert.deepEqual((await fullAudit()).attachmentCounts, { ...clean.attachmentCounts, verified: 2, missing: 1 });
      assert.equal((await checkFile(newer.sourceRecordId)).status, 'verified');
      assert.equal((await audit()).rows.find(row => row.sourceRecordId === older.sourceRecordId)?.status, 'linked');
    } finally { writeFileSync(olderPath, binary.first); }

    const versionRow = f.db.prepare('SELECT json FROM attachment_versions WHERE id=?').get(older.target.id);
    assert.ok(versionRow && typeof versionRow.json === 'string');
    const updateVersion = f.db.prepare('UPDATE attachment_versions SET json=? WHERE id=?');
    try {
      writeFileSync(olderPath, corrupted);
      updateVersion.run(JSON.stringify({ ...(JSON.parse(versionRow.json) as AttachmentVersion), sha256: hash(corrupted) }), older.target.id);
      assert.equal((await checkFile(older.sourceRecordId)).status, 'verified');
      assert.equal((await fullAudit()).attachments.find(row => row.sourceRecordId === older.sourceRecordId)?.status, 'corrupt');
    } finally {
      updateVersion.run(versionRow.json, older.target.id);
      writeFileSync(olderPath, binary.first);
    }

    const open = fileSystem.open;
    const unreadable = t.mock.method(fileSystem, 'open', async (...args: Parameters<typeof open>) => {
      if (String(args[0]) === olderPath) throw Object.assign(new Error('synthetic access failure'), { code: 'EACCES' });
      return open(...args);
    });
    try {
      const report = await fullAudit();
      assert.deepEqual(report.attachmentCounts, { ...clean.attachmentCounts, verified: 2, unreadable: 1 });
      assert.equal(report.attachments.find(row => row.sourceRecordId === older.sourceRecordId)?.status, 'unreadable');
      assert.doesNotMatch(JSON.stringify(report), /synthetic access failure/);
    } finally { unreadable.mock.restore(); }

    const allMatches = await audit('?kind=attachment&status=linked&q=report.bin');
    assert.equal(allMatches.total, 2);
    for (const offset of [0, 1]) {
      const page = await audit(`?kind=attachment&status=linked&q=report.bin&limit=1&offset=${offset}`);
      assert.equal(page.total, 2);
      assert.equal(page.offset, offset);
      assert.equal(page.limit, 1);
      assert.deepEqual(page.counts, initial.counts);
      assert.deepEqual(page.rows, [allMatches.rows[offset]]);
    }
    for (const invalid of ['?limit=0', '?limit=101', '?status=unknown', '?offset=1&offset=2', '?unexpected=true']) {
      assert.equal((await f.call(auditPath + invalid)).status, 400, invalid);
    }
    assert.equal((await f.call(`/source-imports/${randomUUID()}/reconciliation`)).status, 404);
    assert.equal((await f.call(`/source-imports/${randomUUID()}/reconciliation/audit?expectedVersion=1`)).status, 404);
    assert.equal((await f.call(`${auditPath}/audit`)).status, 400);
    assert.equal((await f.call(`${fullPath()}&expectedVersion=2`)).status, 400);
    assert.equal((await f.call(checkFilePath(randomUUID()))).status, 404);

    const key = await f.call<ApiKeyCreated>('/api-keys', 'POST', { name: 'Synthetic project read key', access: 'read', projectIds: receipt.projectIds, expiresAt: null });
    assert.equal(key.status, 201, JSON.stringify(key.data));
    for (const path of [auditPath, checkFilePath(older.sourceRecordId), fullPath()]) {
      const response = await fetch(`${f.base}/v1${path}`, { headers: { Authorization: `Bearer ${key.data.token}` } });
      assert.equal(response.status, 403, path);
      await response.body?.cancel();
    }

    const canonical = await f.call<WorkspaceSnapshot>('/workspace');
    const currentDoc = canonical.data.documents.find(value => value.id === documentId)!;
    const pause = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let intercepted = false;
    const mockedOpen = t.mock.method(fileSystem, 'open', async (...args: Parameters<typeof open>) => {
      if (!intercepted && String(args[0]) === olderPath) {
        intercepted = true;
        pause.resolve();
        await release.promise;
      }
      return open(...args);
    });
    const pending = f.call(fullPath());
    let destination: DocPage;
    try {
      assert.equal(await Promise.race([pause.promise.then(() => true), pending.then(() => false)]), true, 'audit paused at the live attachment read');
      assert.equal((await f.call(fullPath())).status, 429);
      const moved = await f.call<DocPage>(`/documents/${documentId}`, 'PATCH', { projectId: 'project-neo', expectedVersion: currentDoc.version });
      assert.equal(moved.status, 200, JSON.stringify(moved.data));
      destination = moved.data;
      release.resolve();
      assert.equal((await pending).status, 409);
    } finally {
      release.resolve();
      mockedOpen.mock.restore();
      await pending;
    }
    const movedAudit = await audit();
    assert.equal(movedAudit.rows.find(row => row.sourceRecordId === document.sourceRecordId)?.target?.projectId, destination.projectId);
    assert.equal(movedAudit.rows.find(row => row.sourceRecordId === older.sourceRecordId)?.target?.owner?.projectId, destination.projectId);

    assert.equal((await f.call(`/attachments/${removed.target.id}`, 'DELETE')).status, 200);
    const trashed = await f.call<{ trashEntryId: string }>(`/documents/${documentId}`, 'DELETE');
    assert.equal(trashed.status, 200, JSON.stringify(trashed.data));
    const trashAudit = await audit('?status=trashed');
    assert.deepEqual(new Set(trashAudit.rows.map(row => row.sourceRecordId)), new Set(archivedTogether.map(row => row.sourceRecordId)));
    const missingChild = await audit('?status=missing');
    assert.deepEqual(missingChild.rows.map(row => row.sourceRecordId), [removed.sourceRecordId]);
    assert.deepEqual(await checkFile(older.sourceRecordId), expectedOlder);
    const fullTrash = await fullAudit();
    assert.deepEqual(fullTrash.recordCounts, trashAudit.counts);
    assert.deepEqual(fullTrash.attachmentCounts, { ...clean.attachmentCounts, verified: 2, missing: 1 });
    assert.ok([older, newer].every(value => fullTrash.attachments.some(row => row.sourceRecordId === value.sourceRecordId && row.recordStatus === 'trashed' && row.status === 'verified')));

    const backup = await f.call('/export');
    assert.equal(backup.status, 200);
    assert.equal((await f.call('/import', 'POST', { data: backup.data })).status, 200);
    const sameArchived = await audit('?status=trashed');
    assert.equal(sameArchived.receiptVersion, receipt.version + 1);
    assert.deepEqual(sameArchived.rows, trashAudit.rows);
    assert.deepEqual(await checkFile(older.sourceRecordId), expectedOlder);
    assert.equal((await f.call(fullPath())).status, 409);
    assert.deepEqual((await fullAudit(sameArchived.receiptVersion)).attachments, fullTrash.attachments);

    assert.equal((await f.call(`/trash/${trashed.data.trashEntryId}/restore`, 'POST')).status, 200);
    assert.equal((await audit('?status=trashed')).total, 0);
    const restored = await audit();
    assert.ok(archivedTogether.every(original => restored.rows.find(row => row.sourceRecordId === original.sourceRecordId)?.status === 'linked'));
    const trashedAgain = await f.call<{ trashEntryId: string }>(`/documents/${documentId}`, 'DELETE');
    assert.equal(trashedAgain.status, 200);
    assert.equal((await f.call(`/trash/${trashedAgain.data.trashEntryId}`, 'DELETE')).status, 200);
    assert.deepEqual(new Set((await audit('?status=missing')).rows.map(row => row.sourceRecordId)), new Set([...archivedTogether, removed].map(row => row.sourceRecordId)));
    assert.equal((await checkFile(older.sourceRecordId)).status, 'missing');
    assert.equal((await checkFile(archiveOnly.sourceRecordId)).status, 'unbound');
    assert.deepEqual((await fullAudit(restored.receiptVersion)).attachmentCounts, { ...clean.attachmentCounts, verified: 0, missing: 3 });
  } finally { await f.close(); }
});

test('interrupted append recovery removes only uncommitted owned files and retains exact committed versions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'teamspace-migration-recovery-')), append = new AttachmentAppend(dir), file = (text: string): AppendedFile => { const bytes = Buffer.from(text); return { id: randomUUID(), bytes, size: bytes.length, sha256: hash(bytes) }; };
  try {
    const uploads = join(dir, 'uploads'), sentinel = join(uploads, 'operator-note.txt'); writeFileSync(sentinel, 'keep unrelated file');
    const uncommitted = randomUUID(), pending = [file('partially installed'), file('still staged')]; append.stage(uncommitted, pending);
    writeFileSync(join(dir, `.append-${uncommitted}.json`), JSON.stringify({ id: uncommitted, stage: `.append-stage-${uncommitted}`, files: pending.map(value => value.id) }), { mode: 0o600 }); renameSync(join(dir, `.append-stage-${uncommitted}`, pending[0].id), join(uploads, pending[0].id));
    new AttachmentAppend(dir).recover(() => false); for (const value of pending) assert.equal(existsSync(join(uploads, value.id)), false); assert.equal(existsSync(join(dir, `.append-stage-${uncommitted}`)), false);
    const committed = randomUUID(), durable = [file('committed first version'), file('committed latest version')], transaction = append.stage(committed, durable); transaction.install(); assert.equal(existsSync(join(dir, `.append-${committed}.json`)), true);
    new AttachmentAppend(dir).recover(id => id === committed); for (const value of durable) assert.deepEqual(readFileSync(join(uploads, value.id)), value.bytes); assert.equal(readFileSync(sentinel, 'utf8'), 'keep unrelated file'); assert.ok(!readdirSync(dir).some(value => value.startsWith('.append-')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
