import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import fileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { NATIVE_BACKUP_SCHEMA_VERSION } from '../../shared/native-backup.js';
import type {
  LegacyPackageSummary, MigrationApplyResult, MigrationAuthorKind, MigrationAuthorStatus, MigrationOptions, MigrationPreview,
  SourceImport, SourceReconciliationAudit, SourceReconciliationAuthorAudit, SourceReconciliationAuthorFindingsPage,
} from '../../shared/types.js';
import { createApp } from '../../server/app.js';
import { zip } from '../fixtures/legacy-export-zip.mjs';

const originalDate = '2025-01-02T00:00:00.000Z';

async function fixture(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'donefac-migration-author-audit-'));
  const service = createApp({ dataDir, outboundWorker: false });
  const server = service.app.listen(0, '127.0.0.1');
  const db = new DatabaseSync(join(dataDir, 'donefac.sqlite'));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close();
    service.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}/api`;

  async function call<T = unknown>(route: string, method = 'GET', input?: unknown, expected = 200, actor = 'user-seo') {
    const response = await fetch(origin + route, { method,
      headers: { 'X-Actor-Id': actor, 'Content-Type': 'application/json' },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    const raw = await response.text();
    assert.equal(response.status, expected, `${method} ${route}: ${raw}`);
    if (expected === 200 && /\/reconciliation\/(audit|author-findings)\?/.test(route)) {
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
    return JSON.parse(raw) as T;
  }

  async function upload(product: 'jira' | 'confluence', filename: string, bytes: Buffer) {
    const query = new URLSearchParams({ filename, product, instanceKey: `synthetic-${product}-author-verify` });
    const response = await fetch(`${origin}/legacy-import/packages?${query}`, { method: 'POST',
      headers: { 'X-Actor-Id': 'user-seo', 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(bytes),
    });
    const raw = await response.text();
    assert.equal(response.status, 201, raw);
    return JSON.parse(raw) as LegacyPackageSummary;
  }
  return { call, upload, db };
}

function jiraSource() {
  const mapped = { key: 'mapped-source-user', displayName: 'PRIVATE_FIXTURE_AUTHOR' };
  const unmapped = { key: 'unmapped-source-user', displayName: 'PRIVATE_UNMAPPED_AUTHOR' };
  const comment = (id: number, author?: typeof mapped) => ({ id: String(id), body: `PRIVATE_BODY_${id}`, author, created: originalDate });
  const project = { id: '30', key: 'AUR', name: 'Synthetic Jira author project' };
  const fields = { project, status: { id: '1', name: 'Open' }, issuetype: { id: '2', name: 'Task' }, created: originalDate, updated: originalDate };
  return Buffer.from(JSON.stringify({ issues: [{ id: '31', key: 'AUR-1', fields: {
    ...fields, summary: 'Source issue',
    comment: { comments: [comment(40, mapped), comment(41, mapped), comment(42, unmapped), comment(43)] },
    worklog: { worklogs: [{ id: '44', issueId: '31', author: mapped, created: originalDate, started: originalDate, timeSpentSeconds: 91 }] },
  } }, { id: '32', key: 'AUR-2', fields: { ...fields, summary: 'Other issue' } }] }));
}

function confluenceSource() {
  const prop = (name: string, value: string) => `<property name="${name}">${value}</property>`;
  const ref = (name: string, type: string, id: string) => `<property name="${name}" class="${type}"><id name="id">${id}</id></property>`;
  const object = (type: string, id: string, content: string) => `<object class="${type}"><id name="id">${id}</id>${content}</object>`;
  const history = (type: string, id: string) => `<collection name="historicalVersions"><element class="${type}"><id name="id">${id}</id></element></collection>`;
  const date = prop('creationDate', originalDate) + prop('lastModificationDate', originalDate);
  const page = (title: string, version: string) => prop('title', title) + prop('version', version) + ref('space', 'Space', '60') + date;
  const file = (version: string) => prop('title', 'synth.bin') + prop('version', version) + ref('containerContent', 'Page', '61') + date;
  const source = [object('Space', '60', prop('key', 'AUC') + prop('name', 'Synthetic Confluence author space')),
    object('Page', '61', page('Author audit page', '2') + history('Page', '62')),
    object('Page', '62', page('Author audit page previous', '1') + prop('contentStatus', 'historical') + ref('originalVersion', 'Page', '61')),
    object('BodyContent', '63', '<property name="body"><![CDATA[<p>PRIVATE_PAGE_BODY</p>]]></property>' + ref('content', 'Page', '61')),
    object('BodyContent', '64', '<property name="body"><![CDATA[<p>PRIVATE_REVISION_BODY</p>]]></property>' + ref('content', 'Page', '62')),
    object('Attachment', '70', file('2') + history('Attachment', '71')),
    object('Attachment', '71', file('1') + ref('originalVersion', 'Attachment', '70')),
  ].join('');
  return zip([{ path: 'entities.xml', bytes: Buffer.from(`<hibernate-generic>${source}</hibernate-generic>`) },
    { path: 'attachments/61/70/1', bytes: Buffer.from('synthetic archived attachment') },
    { path: 'attachments/61/70/2', bytes: Buffer.from('synthetic current attachment') },
  ]);
}

test('author audit verifies exact imported authors and attachment versions through trash and native restore', async t => {
  const f = await fixture(t);
  const jira = await f.upload('jira', 'authors.json', jiraSource());
  const confluence = await f.upload('confluence', 'authors.zip', confluenceSource());
  const search = new URLSearchParams([['packageId', jira.id], ['packageId', confluence.id]]);
  const options = await f.call<MigrationOptions>(`/migrations/options?${search}`);
  const config = options.defaultConfiguration;
  config.projects = config.projects.map(project => ({ ...project, key: 'AUTH', name: 'Synthetic author audit' }));
  config.datePolicy = 'import-time';
  for (const identity of options.identities) config.users[identity.id] = identity.sourceValue === 'mapped-source-user' ? 'user-jun' : null;
  const plan = await f.call<MigrationPreview>('/migrations/preview', 'POST', { configuration: config }, 201);
  assert.ok(plan.canApply, JSON.stringify(plan.notices));
  const { import: receipt } = await f.call<MigrationApplyResult>(`/migrations/previews/${plan.id}/apply`, 'POST', {
    expectedVersion: plan.version, acknowledgements: plan.requiredAcknowledgements,
  }, 201);
  assert.equal(receipt.authorAttributionVersion, 1);
  const path = `/source-imports/${receipt.id}/reconciliation`;
  const auditPath = `${path}/audit?expectedVersion=${receipt.version}`;
  const findingsPath = (packageId: string, kind: MigrationAuthorKind, status: MigrationAuthorStatus, extras: Record<string, string> = {}) =>
    `${path}/author-findings?${new URLSearchParams({ expectedVersion: String(receipt.version), packageId, kind, status, ...extras })}`;
  const findings = (packageId: string, kind: MigrationAuthorKind, status: MigrationAuthorStatus,
    extras?: Record<string, string>, expected = 200) => f.call<SourceReconciliationAuthorFindingsPage>(findingsPath(packageId, kind, status, extras), 'GET', undefined, expected);
  async function audit() {
    const result = await f.call<SourceReconciliationAudit>(auditPath);
    assert.ok(result.authorAttribution);
    return result.authorAttribution;
  }
  const count = (report: SourceReconciliationAuthorAudit, packageId: string, kind: MigrationAuthorKind, status: MigrationAuthorStatus) =>
    report.packages.find(pkg => pkg.packageId === packageId)?.kinds.find(group => group.kind === kind)?.counts[status];

  const baseline = await audit();
  assert.doesNotMatch(JSON.stringify(baseline), /PRIVATE_|source-user/);
  assert.deepEqual(baseline.packages, plan.authorAttribution);
  assert.equal(count(baseline, jira.id, 'comment', 'mapped'), 2);
  assert.equal(count(baseline, jira.id, 'comment', 'unmapped-fallback'), 1);
  assert.equal(count(baseline, jira.id, 'comment', 'missing-fallback'), 1);
  assert.equal(count(baseline, jira.id, 'worklog', 'mapped'), 1);
  assert.equal(count(baseline, confluence.id, 'document', 'missing-fallback'), 1);
  assert.equal(count(baseline, confluence.id, 'revision', 'missing-fallback'), 1);
  assert.equal(count(baseline, confluence.id, 'attachment', 'missing-fallback'), 2);

  const first = await findings(jira.id, 'comment', 'mapped', { limit: '1', expectedFingerprint: baseline.fingerprint });
  const second = await findings(jira.id, 'comment', 'mapped', { limit: '1', offset: '1', expectedFingerprint: baseline.fingerprint });
  const [comment] = first.rows;
  assert.equal(first.total, 2);
  assert.equal(first.fingerprint, baseline.fingerprint);
  assert.equal(comment.expectedAuthorId, 'user-jun');
  assert.equal(comment.actualAuthorId, 'user-jun');
  assert.notEqual(comment.targetId, second.rows[0].targetId);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_|source-user/);
  await findings(confluence.id, 'comment', 'mapped', { limit: '101' }, 400);
  await findings(jira.id, 'comment', 'mapped', { expectedVersion: String(receipt.version + 1) }, 409);
  await findings('another-package', 'comment', 'mapped', {}, 404);

  const individualComment = await f.call<{ trashItemId: string }>(`/comments/${comment.targetId}`, 'DELETE', undefined, 200, 'user-jun');
  assert.deepEqual(await audit(), baseline);
  await f.call(`/trash/items/${individualComment.trashItemId}`, 'DELETE');
  const missing = await audit();
  assert.equal(count(missing, jira.id, 'comment', 'unavailable'), 1);
  assert.equal((await findings(jira.id, 'comment', 'unavailable')).rows[0].actualAuthorId, null);
  await findings(jira.id, 'comment', 'mapped', { expectedFingerprint: baseline.fingerprint }, 409);

  const intactComment = second.rows[0];
  const storedComment = f.db.prepare('SELECT resource_id AS owner FROM comments WHERE id=?').get(intactComment.targetId) as { owner: string };
  const foreignOwner = f.db.prepare(`SELECT id FROM issues WHERE json_extract(json,'$.title')='Other issue'`).get() as { id: string };
  const changeOwner = f.db.prepare(`UPDATE comments SET resource_id=?,json=json_set(json,'$.resourceId',?) WHERE id=?`);
  changeOwner.run(foreignOwner.id, foreignOwner.id, intactComment.targetId);
  assert.equal((await findings(jira.id, 'comment', 'mismatch')).rows[0].targetId, intactComment.targetId);
  changeOwner.run(storedComment.owner, storedComment.owner, intactComment.targetId);
  const source = f.db.prepare('SELECT json FROM source_records WHERE id=?').get(intactComment.sourceRecordId) as { json: string };
  f.db.prepare(`UPDATE source_records SET json=json_remove(json,'$.authorAttribution') WHERE id=?`).run(intactComment.sourceRecordId);
  assert.equal(count(await audit(), jira.id, 'comment', 'mismatch'), 1);
  f.db.prepare('UPDATE source_records SET json=? WHERE id=?').run(source.json, intactComment.sourceRecordId);

  const page = (await findings(confluence.id, 'document', 'missing-fallback')).rows[0];
  const worklog = (await findings(jira.id, 'worklog', 'mapped')).rows[0];
  const versions = (await findings(confluence.id, 'attachment', 'missing-fallback')).rows;
  const older = versions.find(value => value.sourceId === '71')!;
  const latest = versions.find(value => value.sourceId === '70')!;
  f.db.prepare(`UPDATE worklogs SET author_id='user-min',json=json_set(json,'$.authorId','user-min') WHERE id=?`).run(worklog.targetId);
  f.db.prepare(`UPDATE attachment_versions SET json=json_set(json,'$.authorId','user-min') WHERE id=?`).run(older.targetId);
  const wrong = await audit();
  assert.equal(count(wrong, jira.id, 'worklog', 'mismatch'), 1);
  assert.equal(count(wrong, confluence.id, 'attachment', 'mismatch'), 1);
  assert.equal((await findings(confluence.id, 'attachment', 'mismatch')).rows[0].targetId, older.targetId);
  assert.equal((await findings(confluence.id, 'attachment', 'missing-fallback')).rows[0].targetId, latest.targetId);
  f.db.prepare(`UPDATE worklogs SET author_id='user-jun',json=json_set(json,'$.authorId','user-jun') WHERE id=?`).run(worklog.targetId);
  f.db.prepare(`UPDATE attachment_versions SET json=json_set(json,'$.authorId','user-seo') WHERE id=?`).run(older.targetId);

  // Change document authors while awaiting attachment reads. A document's version is not enough to fence this audit.
  const open = fileSystem.open.bind(fileSystem);
  let changed = false;
  const duringAudit = t.mock.method(fileSystem, 'open', async (...args: Parameters<typeof fileSystem.open>) => {
    if (!changed) {
      changed = true;
      f.db.prepare(`UPDATE documents SET author_id='user-min',json=json_set(json,'$.authorId','user-min') WHERE id=?`).run(page.targetId);
    }
    return open(...args);
  });
  try { await f.call(auditPath, 'GET', undefined, 409); }
  finally { duringAudit.mock.restore(); }
  assert.equal(changed, true);
  assert.equal(count(await audit(), confluence.id, 'document', 'mismatch'), 1);
  f.db.prepare(`UPDATE documents SET author_id='user-seo',json=json_set(json,'$.authorId','user-seo') WHERE id=?`).run(page.targetId);

  const individualAttachment = await f.call<{ trashItemId: string }>(`/attachments/${latest.targetId}`, 'DELETE');
  assert.equal(count(await audit(), confluence.id, 'attachment', 'missing-fallback'), 2);
  await f.call(`/trash/items/${individualAttachment.trashItemId}/restore`, 'POST', {});
  await f.call(`/documents/${page.targetId}`, 'DELETE');
  const archivedPage = await audit();
  assert.equal(count(archivedPage, confluence.id, 'document', 'missing-fallback'), 1);
  assert.equal(count(archivedPage, confluence.id, 'revision', 'missing-fallback'), 1);
  assert.equal(count(archivedPage, confluence.id, 'attachment', 'missing-fallback'), 2);

  const backup = await f.call<Record<string, unknown>>('/export');
  assert.equal(backup.schemaVersion, NATIVE_BACKUP_SCHEMA_VERSION);
  const restored = await fixture(t);
  await restored.call('/import', 'POST', { data: { ...backup, schemaVersion: 110 } }, 400);
  await restored.call('/import', 'POST', { data: { ...backup, schemaVersion: 111 } });
  const restoredReceipt = (await restored.call<SourceImport[]>('/source-imports')).find(value => value.id === receipt.id)!;
  const restoredAudit = await restored.call<SourceReconciliationAudit>(`${path}/audit?expectedVersion=${restoredReceipt.version}`);
  assert.deepEqual(restoredAudit.authorAttribution, archivedPage);

  // Older receipts without an applied author baseline are readable, but have no author-basis page.
  f.db.prepare(`UPDATE source_imports SET json=json_remove(json,'$.authorAttributionVersion') WHERE id=?`).run(receipt.id);
  assert.equal((await f.call<SourceReconciliationAudit>(auditPath)).authorAttribution, null);
  await findings(jira.id, 'comment', 'mapped', {}, 404);
});
