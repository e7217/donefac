import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { AttachmentAppend } from '../../server/attachment-append.js';
import { hash } from '../../server/attachments.js';
import { createApp } from '../../server/app.js';
import type { Attachment, AttachmentHead, AttachmentVersion, DocPage, WorkspaceSnapshot } from '../../shared/types.js';

const originalBytes = Buffer.from('원본 첨부\0\r\n');
const firstPdf = Buffer.from('%PDF-1.6\n% 합성 파일 A\n');
const secondPdf = Buffer.from('%PDF-1.7\n% 합성 파일 B\n');
const originalActor = 'user-seo';
const nextActor = 'user-jun';
type Backup = WorkspaceSnapshot & {
  schemaVersion: number;
  attachments: Attachment[];
  attachmentVersions: AttachmentVersion[];
  attachmentContents: { id: string; data: string }[];
};

async function open(dir: string) {
  const runtime = createApp({ dataDir: dir, outboundWorker: false });
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}/api`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      runtime.close();
    },
  };
}

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'teamspace-attachment-versions-'));
  let running: Awaited<ReturnType<typeof open>> | undefined;
  t.after(async () => {
    try { await running?.close(); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  running = await open(dir);
  const request = (path: string, init?: RequestInit) => fetch(running!.url + path, init);
  function json(path: string, method = 'GET', data?: unknown) {
    return request(path, { method, headers: { 'Content-Type': 'application/json', 'X-Actor-Id': originalActor }, body: data === undefined ? undefined : JSON.stringify(data) });
  }
  function upload(path: string, bytes: Buffer, actorId = nextActor, contentType = 'application/octet-stream') {
    return request(path, { method: 'POST', headers: { 'Content-Type': contentType, 'X-File-Type': 'image/png', 'X-Actor-Id': actorId }, body: new Uint8Array(bytes) });
  }
  function forParent(resourceType: Attachment['resourceType'], resourceId: string) {
    const path = `/attachments?${new URLSearchParams({ resourceType, resourceId })}`;
    return {
      list: () => read<AttachmentHead[]>(request(path)),
      initial: (bytes: Buffer, filename: string) => read<AttachmentHead>(upload(`${path}&${new URLSearchParams({ filename })}`, bytes, originalActor), 201),
    };
  }
  return {
    dir, request, json, upload, forParent,
    async restart(interrupt?: () => void) {
      await running!.close();
      running = undefined;
      interrupt?.();
      running = await open(dir);
    },
  };
}

async function read<T>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending;
  const body = await response.text();
  assert.equal(response.status, status, body);
  return JSON.parse(body) as T;
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const versionsPath = (id: string) => `/attachments/${id}/versions`;
const content = (id: string) => `/attachments/${id}/content`;
const download = (id: string) => `/attachment-versions/${id}/download`;
const appendPath = (id: string, expectedVersionId: string, filename: string) =>
  `${versionsPath(id)}?${new URLSearchParams({ expectedVersionId, filename })}`;
const entries = (f: Fixture) => readdirSync(join(f.dir, 'uploads')).sort();

async function originalFile(f: Fixture) {
  const parent = f.forParent('issue', 'issue-2');
  const first = await parent.initial(originalBytes, '합성 원문.bin');
  assert.equal(first.id, first.currentVersionId);
  assert.equal(first.versionCount, 1);
  assert.deepEqual(await parent.list(), [first]);
  return { parent, first };
}

async function exact(f: Fixture, path: string, expected: Buffer) {
  const response = await f.request(path);
  assert.equal(response.status, 200, path);
  assert.equal(response.headers.get('Content-Type'), 'application/octet-stream');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
}

test('append uses the observed head, preserves immutable byte URLs, and survives restart and parent deletion', async t => {
  const f = await fixture(t);
  const { parent, first } = await originalFile(f);
  const path = appendPath(first.id, first.currentVersionId, '후속 보고서.pdf');
  await read(f.upload(`${versionsPath(first.id)}?filename=test.pdf`, firstPdf), 400);
  await read(f.upload(appendPath(first.id, 'wrong-id', 'test.pdf'), firstPdf), 400);
  await read(f.upload(appendPath(first.id, first.id, '../test.pdf'), firstPdf), 400);
  await read(f.upload(path, firstPdf, nextActor, 'text/plain'), 415);
  await read(f.upload(path, Buffer.alloc(0)), 400);
  await read(f.upload(appendPath(first.id, first.id, 'duplicate.pdf') + `&expectedVersionId=${first.id}`, firstPdf), 400);
  assert.deepEqual(entries(f), [first.id]);

  const database = new DatabaseSync(join(f.dir, 'teamspace.sqlite'));
  try {
    database.exec("CREATE TRIGGER synthetic_version_audit BEFORE INSERT ON activities WHEN json_extract(NEW.json,'$.resourceId')='issue-2' BEGIN SELECT RAISE(ABORT,'synthetic version audit failure'); END;");
    try { await read(f.upload(path, firstPdf), 500); }
    finally { database.exec('DROP TRIGGER synthetic_version_audit'); }
  } finally { database.close(); }
  assert.deepEqual(await parent.list(), [first]);
  assert.deepEqual(entries(f), [first.id]);
  assert.ok(!readdirSync(f.dir).some(name => name.startsWith('.append-')));

  const results = await Promise.all([
    f.upload(path, firstPdf),
    f.upload(path, secondPdf, originalActor),
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  const winning = results.findIndex(result => result.status === 201);
  const winningActor = winning === 0 ? nextActor : originalActor;
  const winningBytes = winning === 0 ? firstPdf : secondPdf;
  const latest = await results[winning].json() as AttachmentHead;
  const conflict = await results[1 - winning].json() as { details: { currentVersionId: string } };
  assert.equal(conflict.details.currentVersionId, latest.currentVersionId);
  assert.equal(latest.id, first.id);
  assert.notEqual(latest.currentVersionId, first.currentVersionId);
  assert.equal(latest.filename, '후속 보고서.pdf');
  assert.equal(latest.mimeType, 'application/pdf');
  assert.equal(latest.authorId, winningActor);
  assert.equal(latest.size, winningBytes.length);
  assert.equal(latest.sha256, hash(winningBytes));
  assert.equal(latest.versionCount, 2);
  const history = await read<AttachmentVersion[]>(f.request(versionsPath(first.id)));
  assert.deepEqual(history.map(version => version.id), [latest.currentVersionId, first.id]);
  assert.equal(history[0].localRevision, 2);
  assert.equal(history[0].sourceImportId, null);
  assert.equal(history[0].sourceRecordId, null);
  assert.equal(history[0].attachmentId, first.id);
  assert.equal(history[1].filename, first.filename);
  assert.equal(history[1].authorId, first.authorId);
  assert.deepEqual(await parent.list(), [latest]);
  await exact(f, content(first.id), originalBytes);
  await exact(f, download(first.id), originalBytes);
  await exact(f, content(latest.currentVersionId), winningBytes);
  await exact(f, download(latest.currentVersionId), winningBytes);
  await read(f.request(content(latest.currentVersionId) + '?inline=1'), 415);

  const workspace = await read<WorkspaceSnapshot>(f.json('/workspace'));
  const attachmentActivities = workspace.activities.filter(event => event.resourceId === first.resourceId && event.detail.includes(latest.filename));
  assert.equal(attachmentActivities.length, 1);
  assert.equal(attachmentActivities[0].actorId, winningActor);
  await f.restart();
  assert.deepEqual(await parent.list(), [latest]);
  assert.deepEqual(await read(f.request(versionsPath(first.id))), history);
  await read(f.upload(path, winningBytes), 409);
  await read(f.json(`/attachments/${first.id}?expectedVersionId=${first.id}`, 'DELETE'), 409);
  assert.deepEqual(entries(f), [first.id, latest.currentVersionId].sort());
  const archived = await read<{trashEntryId:string}>(f.json('/issues/issue-2', 'DELETE'));
  for (const id of [first.id, latest.currentVersionId]) {
    await read(f.request(content(id)), 404);
    await read(f.request(download(id)), 404);
  }
  assert.deepEqual(entries(f), [first.id, latest.currentVersionId].sort());
  await read(f.json(`/trash/${archived.trashEntryId}`, 'DELETE'));
  assert.deepEqual(entries(f), []);
});

test('native backup carries exact immutable version bytes and rejects invalid history atomically', async t => {
  const f = await fixture(t);
  const doc = await read<DocPage>(f.json('/documents', 'POST', { title: '버전 백업 검사' }), 201);
  const parent = f.forParent('document', doc.id);
  const first = await parent.initial(originalBytes, 'first.txt');
  const legacy = await read<Backup>(f.json('/export'));
  legacy.schemaVersion = 15;
  await read(f.json('/import', 'POST', { data: legacy }));
  const second = await read<AttachmentHead>(f.upload(appendPath(first.id, first.id, 'second.pdf'), firstPdf), 201);
  const third = await read<AttachmentHead>(f.upload(appendPath(first.id, second.currentVersionId, 'third.pdf'), secondPdf), 201);
  const history = await read<AttachmentVersion[]>(f.request(versionsPath(first.id)));
  assert.deepEqual(history.map(version => version.id), [third.currentVersionId, second.currentVersionId, first.id]);
  assert.deepEqual(history.slice(0, 2).map(version => version.localRevision), [3, 2]);

  const backup = await read<Backup>(f.json('/export'));
  assert.equal(backup.schemaVersion, 28);
  assert.equal(backup.attachments.length, 1);
  assert.equal(backup.attachments[0].id, first.id);
  assert.equal(backup.attachments[0].filename, 'first.txt');
  const originals = new Map([[first.id, originalBytes], [second.currentVersionId, firstPdf], [third.currentVersionId, secondPdf]]);
  assert.equal(backup.attachmentContents.length, originals.size);
  for (const { id, data } of backup.attachmentContents) assert.deepEqual(Buffer.from(data, 'base64'), originals.get(id));

  const downgrade = { ...backup, schemaVersion: 15 };
  await read(f.json('/import', 'POST', { data: downgrade }), 400);
  const duplicate = structuredClone(backup);
  duplicate.attachmentVersions.find(version => version.id === third.currentVersionId)!.localRevision = 2;
  await read(f.json('/import', 'POST', { data: duplicate }), 400);
  const gap = structuredClone(backup);
  gap.attachmentVersions.find(version => version.id === third.currentVersionId)!.localRevision = 4;
  await read(f.json('/import', 'POST', { data: gap }), 400);
  const corrupt = structuredClone(backup);
  corrupt.attachmentContents.find(item => item.id === second.currentVersionId)!.data = Buffer.from('손상된 버전').toString('base64');
  await read(f.json('/import', 'POST', { data: corrupt }), 400);
  assert.deepEqual(await parent.list(), [third]);
  assert.deepEqual(await read(f.request(versionsPath(first.id))), history);
  for (const [id, bytes] of originals) await exact(f, content(id), bytes);

  await read(f.json(`/attachments/${first.id}`, 'DELETE'));
  assert.deepEqual(entries(f), []);
  await read(f.json('/import', 'POST', { data: backup }));
  assert.deepEqual(await parent.list(), [third]);
  assert.deepEqual(await read(f.request(versionsPath(first.id))), history);
  for (const [id, bytes] of originals) await exact(f, download(id), bytes);
});

test('interrupted per-version journals keep committed files and remove only abandoned bytes on reopen', async t => {
  const f = await fixture(t);
  const { parent, first } = await originalFile(f);
  const { currentVersionId: rootId, versionCount: total, hasVersionHistory, ...root } = first;
  assert.equal(total, 1);
  assert.equal(hasVersionHistory, false);
  assert.equal(rootId, root.id);
  let committed!: AttachmentVersion;
  let abandonedId!: string;
  await f.restart(() => {
    const db = new DatabaseSync(join(f.dir, 'teamspace.sqlite'));
    db.exec('PRAGMA foreign_keys=ON');
    const appender = new AttachmentAppend(f.dir);
    for (const shouldCommit of [false, true]) {
      const id = randomUUID();
      const bytes = shouldCommit ? secondPdf : firstPdf;
      const version: AttachmentVersion = {
        ...root, id, attachmentId: first.id, versionLabel: 'v2', localRevision: 2,
        filename: shouldCommit ? 'committed.pdf' : 'abandoned.pdf', mimeType: 'application/pdf',
        sourceImportId: null, sourceRecordId: null, sha256: hash(bytes), size: bytes.length, createdAt: new Date().toISOString(),
      };
      const staged = appender.stage(id, [{ id, bytes, sha256: version.sha256, size: version.size }]);
      db.exec('BEGIN IMMEDIATE');
      db.prepare('INSERT INTO attachment_versions(id,attachment_id,json) VALUES(?,?,?)').run(id, first.id, JSON.stringify(version));
      staged.install();
      db.exec(shouldCommit ? 'COMMIT' : 'ROLLBACK');
      if (shouldCommit) committed = version;
      else abandonedId = id;
      assert.deepEqual(readFileSync(join(f.dir, 'uploads', id)), bytes);
    }
    db.close();
    assert.equal(readdirSync(f.dir).filter(name => /^\.append-.*\.json$/.test(name)).length, 2);
  });
  assert.deepEqual(entries(f), [first.id, committed.id].sort());
  assert.ok(!readdirSync(f.dir).some(name => name.startsWith('.append-')));
  const [latest] = await parent.list();
  assert.equal(latest.currentVersionId, committed.id);
  assert.equal(latest.versionCount, 2);
  await exact(f, content(first.id), originalBytes);
  await exact(f, content(committed.id), secondPdf);
  await read(f.request(content(abandonedId)), 404);

  const archived = await read<{trashEntryId:string}>(f.json('/issues/issue-2', 'DELETE'));
  const pendingJournal = join(f.dir, `.append-${committed.id}.json`);
  writeFileSync(pendingJournal, JSON.stringify({id:committed.id,stage:`.append-stage-${committed.id}`,files:[committed.id]}));
  await f.restart();
  assert.ok(!readdirSync(f.dir).some(name => name.startsWith('.append-')));
  assert.deepEqual(readFileSync(join(f.dir, 'uploads', committed.id)), secondPdf);
  await read(f.request(content(committed.id)), 404);
  await read(f.json(`/trash/${archived.trashEntryId}/restore`, 'POST', {}));
  await exact(f, content(committed.id), secondPdf);
});
