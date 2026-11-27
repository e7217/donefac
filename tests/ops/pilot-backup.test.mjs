import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { zip } from '../fixtures/legacy-export-zip.mjs';

const cli = fileURLToPath(new URL('../../scripts/pilot-backup.mjs', import.meta.url));
const { createApp } = await tsImport('../../server/app.ts', import.meta.url);
const { AttachmentFiles } = await tsImport('../../server/attachments.ts', import.meta.url);
const { Store } = await tsImport('../../server/store.ts', import.meta.url);
const actor = 'user-seo';
const dbFile = 'donefac.sqlite';
const keyFile = '.credential-key';
const journalFile = '.attachments-import.json';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function tempDirectory(t) {
  const root = mkdtempSync(join(tmpdir(), 'donefac-pilot-backup-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function run(operation, source, target) {
  const result = spawnSync(process.execPath, [cli, operation, source, target], {
    encoding: 'utf8', timeout: 15_000,
  });
  assert.ifError(result.error);
  return result;
}

function succeeds(operation, source, target) {
  const result = run(operation, source, target);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(target));
}

function refuses(operation, source, target, message) {
  const result = run(operation, source, target);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, message);
  assert.equal(existsSync(target), false);
}

async function withWorkspace(directory, exercise) {
  const runtime = createApp({ dataDir: directory, outboundWorker: false, deadlineReminderWorker: false, recurringIssueWorker: false });
  const server = runtime.app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/api`;
    async function request(path, { method = 'GET', body, bytes, status = 200 } = {}) {
      const response = await fetch(base + path, { method, headers: {
        'X-Actor-Id': actor,
        ...(bytes ? { 'Content-Type': 'application/octet-stream' } : body ? { 'Content-Type': 'application/json' } : {}),
      }, body: bytes ?? (body === undefined ? undefined : JSON.stringify(body)) });
      assert.equal(response.status, status, `${method} ${path}: ${response.ok ? '' : await response.text()}`);
      return response;
    }
    return await exercise({
      json: async (path, options) => (await request(path, options)).json(),
      binary: async path => Buffer.from(await (await request(path)).arrayBuffer()),
    });
  } finally {
    server.closeAllConnections();
    try { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    finally { runtime.close(); }
  }
}

async function attach(api, issueId, bytes, filename) {
  const query = new URLSearchParams({ resourceType: 'issue', resourceId: issueId, filename });
  return api.json(`/attachments?${query}`, { method: 'POST', bytes, status: 201 });
}

async function attachmentWithVersion(api, issueId, label) {
  const originalBytes = Buffer.from(`${label} original\0\r\n`);
  const revisedBytes = Buffer.from(`%PDF-1.7\n% ${label} revision\n`);
  const original = await attach(api, issueId, originalBytes, `${label}.bin`);
  const params = new URLSearchParams({ expectedVersionId: original.id, filename: `${label}.pdf` });
  const head = await api.json(`/attachments/${original.id}/versions?${params}`, { method: 'POST', bytes: revisedBytes, status: 201 });
  assert.notEqual(head.currentVersionId, original.id);
  return {
    first: { id: original.id, path: `uploads/${original.id}`, bytes: originalBytes },
    latest: { id: head.currentVersionId, path: `uploads/${head.currentVersionId}`, bytes: revisedBytes },
  };
}

async function fixture(t, { sharedAnchorVersion = false } = {}) {
  const root = tempDirectory(t);
  const source = join(root, 'source');
  const sample = await withWorkspace(source, async api => {
    const resource = await api.json('/issues', {
      method: 'POST', status: 201, body: { projectId: 'project-neo', title: 'Cold backup resource trash fixture' },
    });
    const live = await attachmentWithVersion(api, 'issue-1', 'live');
    const resourceFiles = await attachmentWithVersion(api, resource.id, 'resource-trash');
    const itemFiles = await attachmentWithVersion(api, 'issue-2', 'attachment-trash');
    const { trashEntryId } = await api.json(`/issues/${resource.id}?expectedVersion=${resource.version}`, { method: 'DELETE' });
    const { trashItemId } = await api.json(`/attachments/${itemFiles.first.id}?expectedVersionId=${itemFiles.latest.id}`, { method: 'DELETE' });
    assert.ok(trashEntryId && trashItemId);

    if (sharedAnchorVersion) {
      const exported = await api.json('/export');
      const anchor = exported.attachments.find(file => file.id === live.first.id);
      assert.ok(anchor);
      const version = { ...anchor, attachmentId: anchor.id, versionLabel: '1', sourceImportId: null, sourceRecordId: null };
      exported.attachmentVersions.push(version);
      await api.json('/import', { method: 'POST', body: { data: exported } });
      assert.ok((await api.json('/export')).attachmentVersions.some(file =>
        file.id === anchor.id && file.attachmentId === anchor.id && file.sha256 === anchor.sha256));
    }

    const bytes = zip([{ path: 'issues.csv', bytes: Buffer.from('Issue key,Issue id,Summary\nOFF-1,10001,Offline backup fixture\n') }]);
    const params = new URLSearchParams({ filename: 'fixture.zip', product: 'jira', instanceKey: 'cold-backup-synthetic' });
    const pkg = await api.json(`/legacy-import/packages?${params}`, { method: 'POST', bytes, status: 201 });
    assert.equal(pkg.sha256, sha256(bytes));
    const bundle = { id: pkg.id, path: `legacy-imports/${pkg.id}.bundle`, bytes };
    return { live, resourceFiles, itemFiles, bundle, trashEntryId, trashItemId };
  });
  return { root, source, ...sample };
}

test('cold backup and restore preserve registered original and revised attachments, both trash forms and a staged ZIP', async t => {
  const f = await fixture(t, { sharedAnchorVersion: true });
  const backup = join(f.root, 'backup');
  const restored = join(f.root, 'restored');
  const files = [f.live.first, f.live.latest, f.resourceFiles.first, f.resourceFiles.latest, f.itemFiles.first, f.itemFiles.latest, f.bundle];
  succeeds('backup', f.source, backup);
  succeeds('restore', backup, restored);
  const manifest = JSON.parse(readFileSync(join(backup, 'manifest.json'), 'utf8'));
  assert.equal(manifest.files.filter(row => row.path === f.live.first.path).length, 1);
  for (const file of files) {
    for (const directory of [f.source, join(backup, 'data'), restored]) {
      assert.deepEqual(readFileSync(join(directory, file.path)), file.bytes);
    }
  }
  await withWorkspace(restored, async api => {
    await api.json(`/trash/${f.trashEntryId}/restore`, { method: 'POST' });
    await api.json(`/trash/items/${f.trashItemId}/restore`, { method: 'POST' });
    for (const file of files.slice(0, -1)) {
      assert.deepEqual(await api.binary(`/attachment-versions/${file.id}/download`), file.bytes);
    }
    const packages = await api.json('/legacy-import/packages');
    assert.deepEqual(packages.map(row => [row.id, row.sha256]), [[f.bundle.id, sha256(f.bundle.bytes)]]);
  });
});

function damage(root, file, missing) {
  const path = join(root, file.path);
  if (missing) {
    rmSync(path);
    return null;
  }
  const changed = Buffer.from(file.bytes);
  changed[0] ^= 1;
  assert.equal(changed.length, file.bytes.length);
  assert.notEqual(sha256(changed), sha256(file.bytes));
  writeFileSync(path, changed);
  return changed;
}

function confirmDamage(root, file, changed) {
  if (changed === null) assert.equal(existsSync(join(root, file.path)), false);
  else assert.deepEqual(readFileSync(join(root, file.path)), changed);
}

test('cold backup restores the exact document save receipt alongside later edits', async t => {
  const root = tempDirectory(t);
  const source = join(root, 'source');
  const backup = join(root, 'backup');
  const restored = join(root, 'restored');
  const { path, body, saved, latest } = await withWorkspace(source, async api => {
    const document = await api.json('/documents', {
      method: 'POST', status: 201, body: { projectId: 'project-neo', title: 'Document receipt backup fixture' },
    });
    const { restoreGeneration } = await api.json('/workspace');
    assert.ok(restoreGeneration);
    const path = `/documents/${document.id}`;
    const body = { requestId: randomUUID(), expectedRestoreGeneration: restoreGeneration, expectedVersion: document.version,
      title: 'Saved before backup', labels: ['Original'] };
    const saved = await api.json(path, { method: 'PATCH', body });
    const latest = await api.json(path, { method: 'PATCH', body: { expectedVersion: saved.version, title: 'Edited after the original save' } });
    return { path, body, saved, latest };
  });

  succeeds('backup', source, backup);
  succeeds('restore', backup, restored);
  await withWorkspace(restored, async api => {
    assert.deepEqual(await api.json(path, { method: 'PATCH', body }), saved);
    const { documents } = await api.json('/workspace');
    assert.deepEqual(documents.find(document => document.id === saved.id), latest);
    const history = await api.json(`${path}/revisions`);
    assert.equal(history.filter(revision => revision.version === saved.version).length, 1);
  });
});

test('cold backup rejects preexisting missing or wrong referenced bytes without publishing or altering the source', async t => {
  const f = await fixture(t);
  const damageCases = [
    [f.live.first, true], [f.live.latest, false], [f.resourceFiles.first, false],
    [f.resourceFiles.latest, true], [f.itemFiles.first, true], [f.itemFiles.latest, false],
    [f.bundle, false], [f.bundle, true],
  ];
  for (const [index, [file, missing]] of damageCases.entries()) {
    const source = join(f.root, `damaged-source-${index}`);
    cpSync(f.source, source, { recursive: true });
    const changed = damage(source, file, missing);
    const databaseBytes = readFileSync(join(source, dbFile));
    refuses('backup', source, join(f.root, `rejected-backup-${index}`), missing ? /없습니다/u : /무결성/u);
    assert.deepEqual(readFileSync(join(source, dbFile)), databaseBytes);
    confirmDamage(source, file, changed);
  }
  assert.ok(!readdirSync(f.root).some(name => name.startsWith('.donefac-backup-')));
});

test('cold restore rejects damaged references even when the outer backup manifest matches the damaged copy', async t => {
  const f = await fixture(t);
  const original = join(f.root, 'valid-backup');
  succeeds('backup', f.source, original);
  const damageCases = [[f.live.latest, false], [f.resourceFiles.first, true], [f.itemFiles.latest, false], [f.bundle, true], [f.bundle, false]];
  for (const [index, [file, missing]] of damageCases.entries()) {
    const backup = join(f.root, `damaged-backup-${index}`);
    cpSync(original, backup, { recursive: true });
    const payload = join(backup, 'data');
    const changed = damage(payload, file, missing);
    const path = join(backup, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    const before = manifest.files.find(entry => entry.path === file.path);
    assert.ok(before);
    if (changed === null) manifest.files = manifest.files.filter(entry => entry.path !== file.path);
    else Object.assign(before, { size: changed.length, sha256: sha256(changed) });
    const manifestText = JSON.stringify(manifest);
    writeFileSync(path, manifestText);
    const databaseBytes = readFileSync(join(payload, dbFile));

    refuses('restore', backup, join(f.root, `rejected-restore-${index}`), missing ? /없습니다/u : /무결성/u);
    assert.equal(readFileSync(path, 'utf8'), manifestText);
    assert.deepEqual(readFileSync(join(payload, dbFile)), databaseBytes);
    confirmDamage(payload, file, changed);
  }
  assert.ok(!readdirSync(f.root).some(name => name.startsWith('.donefac-restore-')));
});

test('cold backup validates the attachment directory selected by native import recovery before and after SQLite commit', async t => {
  const root = tempDirectory(t);
  const witness = join(root, 'witness');
  const previousBytes = Buffer.from('previous attachment before native import');
  const replacementBytes = Buffer.from('replacement attachment after native import');
  const { id } = await withWorkspace(witness, api => attach(api, 'issue-1', previousBytes, 'import-fixture.bin'));
  for (const committed of [false, true]) {
    const source = join(root, `crash-${committed}`);
    cpSync(witness, source, { recursive: true });
    const store = new Store(source);
    const attachments = new AttachmentFiles(source);
    try {
      const original = store.get('attachments', id);
      const replacement = { ...original, size: replacementBytes.length, sha256: sha256(replacementBytes) };
      const stage = attachments.stageImport([replacement], [{ id, data: replacementBytes.toString('base64') }]);
      const generation = randomUUID();
      store.db.exec('BEGIN IMMEDIATE');
      store.put('attachments', replacement);
      store.setSetting('attachmentImportGeneration', generation);
      attachments.swapImport(stage, generation);
      store.db.exec(committed ? 'COMMIT' : 'ROLLBACK');
    } finally { store.db.close(); }

    const journal = readFileSync(join(source, journalFile), 'utf8');
    const previousPath = JSON.parse(journal).backup;
    assert.deepEqual(readFileSync(join(source, previousPath, id)), previousBytes);
    assert.deepEqual(readFileSync(join(source, 'uploads', id)), replacementBytes);

    const backup = join(root, `crash-backup-${committed}`);
    const restored = join(root, `crash-restore-${committed}`);
    succeeds('backup', source, backup);
    succeeds('restore', backup, restored);
    for (const dir of [source, join(backup, 'data'), restored]) {
      assert.equal(readFileSync(join(dir, journalFile), 'utf8'), journal);
      assert.deepEqual(readFileSync(join(dir, previousPath, id)), previousBytes);
      assert.deepEqual(readFileSync(join(dir, 'uploads', id)), replacementBytes);
    }
    await withWorkspace(restored, async api => {
      assert.deepEqual(await api.binary(`/attachments/${id}/content`), committed ? replacementBytes : previousBytes);
    });
    assert.equal(existsSync(join(restored, journalFile)), false);
    assert.equal(existsSync(join(restored, previousPath)), false);
    assert.equal(readFileSync(join(source, journalFile), 'utf8'), journal);
  }
});

test('startup preserves GitLab and outbound signing credentials when a workspace copy is missing its key', async t => {
  const root = tempDirectory(t);
  const secrets = {
    token: 'synthetic-api-token',
    webhookSecret: 'synthetic-inbound-secret',
    signingToken: `whsec_${Buffer.alloc(32, 7).toString('base64')}`,
  };

  for (const kind of [...Object.keys(secrets), 'outbound']) {
    await t.test(kind, async () => {
      const directory = join(root, kind);
      const secret = await withWorkspace(directory, async api => {
        if (kind === 'outbound') {
          const created = await api.json('/webhook-endpoints', {
            method: 'POST', status: 201,
            body: { name: 'Synthetic endpoint', url: 'https://outbound.invalid/', eventTypes: ['issue.created'] },
          });
          return created.secret;
        }
        await api.json('/integrations/gitlab', {
          method: 'PATCH',
          body: { expectedVersion: 1, baseUrl: 'https://gitlab.invalid/', projectIds: [1], [kind]: secrets[kind] },
        });
        return secrets[kind];
      });
      const keyPath = join(directory, keyFile);
      const key = readFileSync(keyPath);
      const database = readFileSync(join(directory, dbFile));
      rmSync(keyPath);

      assert.throws(() => new Store(directory), /원본 \.credential-key 파일이 필요/u);
      assert.equal(existsSync(keyPath), false);
      assert.deepEqual(readFileSync(join(directory, dbFile)), database);

      writeFileSync(keyPath, key);
      const reopened = new Store(directory);
      try {
        const ciphertext = kind === 'outbound'
          ? reopened.db.prepare('SELECT secret FROM webhook_endpoints').get().secret
          : reopened.setting('gitlab')[kind];
        assert.equal(reopened.unseal(ciphertext), secret);
      } finally { reopened.db.close(); }
    });
  }
});

test('cold backup and restore require a matching key even if the backup manifest matches a replaced key', async t => {
  const root = tempDirectory(t);
  const source = join(root, 'source'), backup = join(root, 'backup'), restore = join(root, 'restore');
  const secret = 'synthetic-cold-backup-gitlab-token';
  await withWorkspace(source, async api => {
    await api.json('/integrations/gitlab', {
      method: 'PATCH',
      body: { expectedVersion: 1, baseUrl: 'https://gitlab.invalid/', projectIds: [1], token: secret },
    });
  });
  const keyPath = join(source, keyFile), originalKey = readFileSync(keyPath);
  const wrongKey = Buffer.from(originalKey);
  wrongKey[0] ^= 1;
  const mismatch = /\.credential-key로 저장된 자격 증명을 확인할 수 없습니다/u;

  writeFileSync(keyPath, wrongKey);
  assert.throws(() => new Store(source), mismatch);
  refuses('backup', source, join(root, 'rejected-backup'), mismatch);
  assert.deepEqual(readFileSync(keyPath), wrongKey);
  assert.ok(!readdirSync(root).some(name => name.startsWith('.donefac-backup-')));

  writeFileSync(keyPath, originalKey);
  succeeds('backup', source, backup);
  succeeds('restore', backup, restore);
  const recovered = new Store(restore);
  try { assert.equal(recovered.unseal(recovered.setting('gitlab').token), secret); }
  finally { recovered.db.close(); }

  const backupKey = join(backup, 'data', keyFile);
  const manifestPath = join(backup, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.files.find(file => file.path === keyFile).sha256 = sha256(wrongKey);
  const manifestText = JSON.stringify(manifest);
  writeFileSync(backupKey, wrongKey);
  writeFileSync(manifestPath, manifestText);

  refuses('restore', backup, join(root, 'rejected-restore'), mismatch);
  assert.deepEqual(readFileSync(backupKey), wrongKey);
  assert.equal(readFileSync(manifestPath, 'utf8'), manifestText);
  assert.ok(!readdirSync(root).some(name => name.startsWith('.donefac-restore-')));
});

test('older workspaces without stored credentials can generate a fresh key', async t => {
  const root = tempDirectory(t);
  const legacy = new DatabaseSync(join(root, dbFile));
  legacy.exec('CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES(\'preserved\')');
  legacy.close();

  const upgraded = new Store(root);
  try {
    assert.equal(upgraded.db.prepare('SELECT value FROM marker').get().value, 'preserved');
    upgraded.setSetting('gitlab', { baseUrl: 'https://gitlab.invalid/', projectIds: [1] });
  } finally { upgraded.db.close(); }
  const keyPath = join(root, keyFile);
  rmSync(keyPath);
  const reopened = new Store(root);
  try {
    assert.deepEqual(reopened.setting('gitlab').projectIds, [1]);
    assert.equal(readFileSync(keyPath).length, 32);
  } finally { reopened.db.close(); }
});
