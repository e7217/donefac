import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import type { Attachment, AttachmentVersion, LegacyPackageSummary, MigrationApplyResult, MigrationConfiguration, MigrationOptions, MigrationPreview, SourceImport, SourceRecordArchive, SourceRecordPage, WebhookEndpointCreated, WorkspaceSnapshot } from '../../shared/types.js';
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
function zip(entries: { path: string; bytes: Buffer }[]): Buffer {
  const pieces: Buffer[] = [], directory: Buffer[] = []; let offset = 0;
  for (const entry of entries) { const name = Buffer.from(entry.path), bytes = deflateRawSync(entry.bytes), checksum = crc32(entry.bytes), local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(entry.bytes.length, 22); local.writeUInt16LE(name.length, 26); pieces.push(local, name, bytes);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(3 << 8 | 20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(entry.bytes.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE((0o100644 << 16) >>> 0, 38); central.writeUInt32LE(offset, 42); directory.push(central, name); offset += local.length + name.length + bytes.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...pieces, central, end]);
}
function confluence() {
  const first = Buffer.from('첫 버전\r\n\x00바이너리'), latest = Buffer.from('두 번째 버전😀\r\n원본');
  const prop = (name: string, text: string) => `<property name="${name}">${text}</property>`, ref = (name: string, type: string, id: string) => `<property name="${name}" class="${type}"><id name="id">${id}</id></property>`, object = (type: string, id: string, text: string) => `<object class="${type}"><id name="id">${id}</id>${text}</object>`;
  const xml = `<hibernate-generic>${object('Space', '42', prop('key', 'SYN') + prop('name', 'Synthetic archive'))}${object('Page', '100', prop('title', 'Synthetic versioned page') + prop('version', '1') + ref('space', 'Space', '42') + prop('creationDate', '2020-01-01T00:00:00Z') + prop('lastModificationDate', '2020-01-02T00:00:00Z'))}${object('BodyContent', '300', '<property name="body"><![CDATA[<p>보존한 문서 본문</p>]]></property>' + ref('content', 'Page', '100'))}${object('Attachment', '700', prop('title', 'report.bin') + prop('version', '2') + ref('containerContent', 'Page', '100') + '<collection name="historicalVersions"><element class="Attachment"><id name="id">701</id></element></collection>' + prop('creationDate', '2020-01-02T00:00:00Z'))}${object('Attachment', '701', prop('title', 'report.bin') + prop('version', '1') + ref('containerContent', 'Page', '100') + ref('originalVersion', 'Attachment', '700') + prop('creationDate', '2020-01-01T00:00:00Z'))}</hibernate-generic>`;
  return { first, latest, bytes: zip([{ path: 'entities.xml', bytes: Buffer.from(xml) }, { path: 'attachments/100/700/1', bytes: first }, { path: 'attachments/100/700/2', bytes: latest }]) };
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
    const backup = (await f.call<Record<string, unknown>>('/export')).data; assert.equal(backup.schemaVersion, 12); assert.equal((backup.attachmentVersions as unknown[]).length, 2); assert.equal((backup.attachmentContents as unknown[]).length, 3);
    const invalidNotice = structuredClone(backup); (invalidNotice.sourceImports as SourceImport[])[0].notices = [{ severity: 'error', code: 'SYNTHETIC_BLOCKER', message: '완료된 영수증에 오류를 넣을 수 없음', recordId: null, requiresAcknowledgement: false }]; assert.equal((await f.call('/import', 'POST', { data: invalidNotice })).status, 400); await exactDownloads();
    const invalid = structuredClone(backup); (invalid.resourceLinks as { documentId: string }[])[0].documentId = 'synthetic-missing-document'; const snapshot = (await f.call<WorkspaceSnapshot>('/workspace')).data;
    assert.equal((await f.call('/import', 'POST', { data: invalid })).status, 404); assert.deepEqual((await f.call<WorkspaceSnapshot>('/workspace')).data, snapshot); await exactDownloads();
    assert.equal((await f.call('/import', 'POST', { data: backup })).status, 200); await exactDownloads();
    const after = (await f.call<SourceImport[]>('/source-imports')).data[0]; assert.equal(after.version, 2); assert.deepEqual(after.notices, plan.notices);
    const archives = (await f.call<SourceRecordPage>(`/source-imports/${plan.id}/records?kind=attachment`)).data; assert.equal(archives.total, 2); const archive = (await f.call<SourceRecordArchive>(`/source-imports/${plan.id}/records/${archives.records[0].id}`)).data; assert.equal(archive.record.kind, 'attachment');
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
