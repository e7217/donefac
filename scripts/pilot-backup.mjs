import { createHash } from 'node:crypto';
import { constants, lstatSync, realpathSync, readdirSync, mkdirSync, mkdtempSync, openSync, closeSync, readSync, writeSync, fstatSync, fsyncSync, chmodSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, basename, resolve, join, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const SCRIPT = fileURLToPath(import.meta.url);
const WRAPPER = join(dirname(SCRIPT), 'pilot-lock.sh');
const FORMAT = 'teamspace-pilot-cold-backup';
const DB = 'teamspace.sqlite';
const KEY = '.credential-key';
const MANIFEST = 'manifest.json';
const MAX_MANIFEST = 64 * 1024 * 1024;
const MAX_ENTRIES = 1_000_000;
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const SHA256 = /^[a-f\d]{64}$/u;
function fail(message, exitCode = 1) { const error = new Error(message); error.exitCode = exitCode; throw error; }
function exists(path) { try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function directory(path) { const value = lstatSync(path); if (!value.isDirectory() || value.isSymbolicLink()) fail(`일반 디렉터리가 필요합니다: ${path}`); }
function privateDirectory(path) { mkdirSync(path, { mode: 0o700 }); chmodSync(path, 0o700); }
function sync(path) { const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
function absolute(value) { if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) fail('원본과 목적지는 절대 경로여야 합니다.'); return resolve(value); }
function sourcePath(value) { const path = absolute(value); directory(path); return realpathSync(path); }
function newPath(value) {
  const path = absolute(value), parent = dirname(path); directory(parent);
  const result = join(realpathSync(parent), basename(path));
  if (exists(result)) fail(`기존 목적지를 교체하지 않습니다: ${result}`);
  return result;
}
function within(parent, child) { const part = relative(parent, child); return part === '' || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); }
function paths(source, target) {
  const from = sourcePath(source), to = newPath(target);
  if (within(from, to) || within(to, from)) fail('원본과 목적지는 같거나 서로 중첩될 수 없습니다.');
  return { from, to };
}
function fingerprint(stat) { return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':'); }
function walk(root) {
  directory(root);
  const directories = [''], files = [], stack = [''];
  let entries = 0;
  while (stack.length) {
    const part = stack.pop();
    for (const name of readdirSync(join(root, part)).sort()) {
      const path = part ? part + '/' + name : name, full = join(root, path), stat = lstatSync(full, { bigint: true });
      if (++entries > MAX_ENTRIES || path.split('/').length > 128) fail('파일 수 또는 디렉터리 깊이 한도를 초과했습니다. 백업을 나누어 주세요.');
      if (stat.isSymbolicLink()) fail(`심볼릭 링크는 백업·복원할 수 없습니다: ${path}`);
      if (stat.isDirectory()) { directories.push(path); stack.push(path); }
      else if (stat.isFile()) {
        if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) fail(`파일 크기 한도를 초과했습니다: ${path}`);
        files.push({ path, size: Number(stat.size), fingerprint: fingerprint(stat) });
      } else fail(`일반 파일과 디렉터리만 허용합니다: ${path}`);
    }
  }
  return { directories: directories.sort(), files: files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
}
function regularFd(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  if (!fstatSync(fd).isFile()) { closeSync(fd); fail(`일반 파일이 아닙니다: ${path}`); }
  return fd;
}
function digest(path) {
  const fd = regularFd(path), buffer = Buffer.allocUnsafe(1024 * 1024), sum = createHash('sha256');
  let size = 0;
  try { let count; while ((count = readSync(fd, buffer, 0, buffer.length, null))) { sum.update(buffer.subarray(0, count)); size += count; } }
  finally { closeSync(fd); }
  return { size, sha256: sum.digest('hex') };
}
function copyTree(source, target, tree) {
  for (const path of tree.directories) if (path) privateDirectory(join(target, path));
  for (const entry of tree.files) {
    const sourceFile = join(source, entry.path), targetFile = join(target, entry.path);
    if (realpathSync(sourceFile) !== sourceFile) fail(`심볼릭 링크 경로를 거절했습니다: ${entry.path}`);
    const input = regularFd(sourceFile), output = openSync(targetFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      const before = fstatSync(input, { bigint: true });
      if (fingerprint(before) !== entry.fingerprint) fail(`복사 전에 원본이 변경되었습니다: ${entry.path}`);
      const buffer = Buffer.allocUnsafe(1024 * 1024); let count;
      while ((count = readSync(input, buffer, 0, buffer.length, null))) {
        let written = 0;
        while (written < count) written += writeSync(output, buffer, written, count - written);
      }
      if (fingerprint(fstatSync(input, { bigint: true })) !== entry.fingerprint) fail(`복사 중 원본이 변경되었습니다: ${entry.path}`);
      fsyncSync(output);
    } finally { closeSync(input); closeSync(output); }
    chmodSync(targetFile, 0o600);
  }
  const after = walk(source);
  if (JSON.stringify(after) !== JSON.stringify(tree)) fail('복사 중 원본 파일 목록 또는 내용이 변경되었습니다.');
}
function credential(root) {
  const path = join(root, KEY), fd = regularFd(path);
  try { if (fstatSync(fd).size !== 32) fail('32바이트 .credential-key 파일이 필요합니다.'); } finally { closeSync(fd); }
}
function attachmentImportJournal(root) {
  const path = join(root, '.attachments-import.json');
  if (!exists(path)) return null;
  const record = jsonFile(path, MAX_MANIFEST);
  if (!record || typeof record !== 'object' || !UUID.test(record.generation) || !/^\.uploads-import-[a-f\d-]{36}$/.test(record.stage) || !/^\.uploads-previous-[a-f\d-]{36}$/.test(record.backup)) fail('첨부파일 교체 복구 저널이 올바르지 않습니다.');
  for (const name of [record.stage, record.backup]) if (exists(join(root, name))) directory(join(root, name));
  return record;
}
function recoveryJournals(root) {
  const result = attachmentImportJournal(root) ? ['.attachments-import.json'] : [];
  for (const name of readdirSync(root)) if (/^\.append-[a-f\d-]{36}\.json$/.test(name)) {
    const record = jsonFile(join(root, name), MAX_MANIFEST);
    if (!record || typeof record !== 'object' || !UUID.test(record.id) || name !== `.append-${record.id}.json` || record.stage !== `.append-stage-${record.id}` || !Array.isArray(record.files) || record.files.length > 100000 || new Set(record.files).size !== record.files.length || record.files.some(id => typeof id !== 'string' || !UUID.test(id))) fail('첨부파일 추가 복구 저널이 올바르지 않습니다.');
    result.push(name);
  }
  return result.sort();
}

function workspaceFileInventory(db, tables, uploadDirectory) {
  const expected = new Map();
  function add(file, base, extension = '', id = file?.id) {
    if (typeof id !== 'string' || !UUID.test(id) || file?.id !== id ||
        !Number.isSafeInteger(file.size) || file.size < 1 || typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)) {
      fail('SQLite의 첨부파일 또는 이관 원본 메타데이터가 올바르지 않습니다.');
    }
    const path = `${base}/${id}${extension}`;
    const known = expected.get(path);
    if (known && (known.size !== file.size || known.sha256 !== file.sha256)) {
      fail(`SQLite의 파일 메타데이터가 일치하지 않습니다: ${path}`);
    }
    expected.set(path, { size: file.size, sha256: file.sha256 });
  }
  for (const [table, base, extension] of [
    ['attachments', uploadDirectory, ''], ['attachment_versions', uploadDirectory, ''],
    ['legacy_packages', 'legacy-imports', '.bundle'],
  ]) {
    if (!tables.has(table)) continue;
    for (const { id, json } of db.prepare(`SELECT id, json FROM ${table}`).iterate()) {
      add(JSON.parse(json), base, extension, id);
    }
  }
  if (tables.has('trash_entries')) {
    for (const { attachments, versions } of db.prepare(`SELECT json_extract(json, '$.attachments') AS attachments,
      json_extract(json, '$.attachmentVersions') AS versions FROM trash_entries`).iterate()) {
      const files = JSON.parse(attachments), history = JSON.parse(versions ?? '[]');
      if (!Array.isArray(files) || !Array.isArray(history)) fail('SQLite의 휴지통 첨부 목록이 올바르지 않습니다.');
      for (const entry of files) add(entry, uploadDirectory);
      for (const entry of history) add(entry, uploadDirectory);
    }
  }
  if (tables.has('trash_items')) {
    for (const { item, versions } of db.prepare(`SELECT json_extract(json, '$.item') AS item,
      json_extract(json, '$.versions') AS versions FROM trash_items WHERE item_type='attachment'`).iterate()) {
      add(JSON.parse(item), uploadDirectory);
      const history = JSON.parse(versions);
      if (!Array.isArray(history)) fail('SQLite의 개별 휴지통 첨부 버전 목록이 올바르지 않습니다.');
      for (const entry of history) add(entry, uploadDirectory);
    }
  }
  return expected;
}

function validateDatabase(root, checkpoint) {
  credential(root);
  const path = join(root, DB), fd = regularFd(path); closeSync(fd);
  const db = new DatabaseSync(path, { readOnly: !checkpoint, enableForeignKeyConstraints: true });
  let expected;
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    for (const name of ['users', 'projects', 'issues', 'documents', 'settings']) {
      if (!tables.has(name)) fail('Teamspace 데이터베이스의 기본 테이블이 없습니다.');
      const fields = new Set(db.prepare(`PRAGMA table_info(${name})`).all().map(row => row.name));
      for (const column of name === 'settings' ? ['key', 'value'] : ['id', 'json']) if (!fields.has(column)) fail('Teamspace 데이터베이스의 기본 열이 없습니다.');
    }
    const check = db.prepare('PRAGMA quick_check').all();
    if (check.length !== 1 || check[0].quick_check !== 'ok') fail('SQLite quick_check에 실패했습니다.');
    if (db.prepare('PRAGMA foreign_key_check').all().length) fail('SQLite 외래 키 검사에 실패했습니다.');
    const generation = db.prepare("SELECT value FROM settings WHERE key='attachmentImportGeneration'").get();
    const committedGeneration = generation ? JSON.parse(generation.value) : null;
    const journal = attachmentImportJournal(root);
    // Match the upload directory that AttachmentFiles.recover will retain at startup.
    const uploads = journal && committedGeneration !== journal.generation && exists(join(root, journal.backup))
      ? journal.backup : 'uploads';
    if (journal) directory(join(root, uploads));
    expected = workspaceFileInventory(db, tables, uploads);
    if (checkpoint) {
      const result = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      if (result && result.busy !== 0) fail('복사본 WAL 체크포인트를 완료하지 못했습니다.');
    }
  } finally { db.close(); }
  if (checkpoint) sync(path);
  return expected;
}

function verifyWorkspaceFiles(manifest, expected) {
  const files = new Map(manifest.files.map(file => [file.path, file]));
  for (const [path, metadata] of expected) {
    const file = files.get(path);
    if (!file) fail(`SQLite가 참조하는 파일이 없습니다: ${path}`);
    if (file.size !== metadata.size || file.sha256 !== metadata.sha256) {
      fail(`SQLite가 참조하는 파일의 무결성 검사에 실패했습니다: ${path}`);
    }
  }
}
function jsonFile(path, limit) {
  const fd = regularFd(path);
  try {
    if (fstatSync(fd).size > limit) fail('매니페스트 또는 복구 저널이 너무 큽니다.');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}
function validRelative(value, empty = false) {
  return typeof value === 'string' && (empty && value === '' || value.length > 0 && !value.includes('\0') && !isAbsolute(value) && value.split('/').every(part => part && part !== '.' && part !== '..'));
}
function clearReadonlyCaches(root, manifest) {
  const expected = new Set(manifest.files.map(file => file.path));
  const wal = `${DB}-wal`, shm = `${DB}-shm`;
  if (!expected.has(wal) && exists(join(root, wal))) {
    const fd = regularFd(join(root, wal));
    try { if (fstatSync(fd).size !== 0) fail('읽기 검증 후 예상하지 못한 WAL 데이터가 남았습니다. 복원을 게시하지 않습니다.'); }
    finally { closeSync(fd); }
    rmSync(join(root, wal));
  }
  if (!expected.has(shm) && exists(join(root, shm))) {
    const fd = regularFd(join(root, shm)); closeSync(fd);
    rmSync(join(root, shm));
  }
}
function manifestOf(root) {
  const tree = walk(root);
  return { format: FORMAT, version: 1, createdAt: new Date().toISOString(), directories: tree.directories, files: tree.files.map(file => ({ path: file.path, ...digest(join(root, file.path)) })), recoveryPending: recoveryJournals(root) };
}
function verifyBackup(root) {
  const manifest = jsonFile(join(root, MANIFEST), MAX_MANIFEST);
  if (!manifest || manifest.format !== FORMAT || manifest.version !== 1 || typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt)) || !Array.isArray(manifest.directories) || !Array.isArray(manifest.files) || manifest.files.length + manifest.directories.length > MAX_ENTRIES || !manifest.directories.includes('')) fail('지원하는 Teamspace 물리 백업 매니페스트가 필요합니다.');
  const seen = new Set();
  for (const path of manifest.directories) { if (!validRelative(path, true) || seen.has(path)) fail('매니페스트의 디렉터리 경로가 올바르지 않습니다.'); seen.add(path); }
  for (const file of manifest.files) {
    if (!file || !validRelative(file.path) || seen.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)) fail('매니페스트의 파일 경로·크기·해시가 올바르지 않습니다.');
    seen.add(file.path);
  }
  const tree = walk(root), expectedDirectories = ['', ...manifest.directories.map(path => path ? `data/${path}` : 'data')].sort(), expectedFiles = [MANIFEST, ...manifest.files.map(file => `data/${file.path}`)].sort();
  if (JSON.stringify(tree.directories) !== JSON.stringify(expectedDirectories) || JSON.stringify(tree.files.map(file => file.path)) !== JSON.stringify(expectedFiles)) fail('매니페스트와 실제 백업 파일·디렉터리 목록이 다릅니다.');
  for (const file of manifest.files) {
    const actual = digest(join(root, 'data', file.path));
    if (actual.size !== file.size || actual.sha256 !== file.sha256) fail(`백업 파일의 크기 또는 SHA-256이 일치하지 않습니다: ${file.path}`);
  }
  credential(join(root, 'data'));
  if (!seen.has(DB) || !seen.has(KEY)) fail('백업에 Teamspace 데이터베이스와 키가 없습니다.');
  if (!Array.isArray(manifest.recoveryPending) || JSON.stringify(manifest.recoveryPending) !== JSON.stringify(recoveryJournals(join(root, 'data')))) fail('백업의 복구 저널 목록이 매니페스트와 다릅니다.');
  return manifest;
}
function publish(stage, target) {
  if (exists(target)) fail(`기존 목적지를 교체하지 않습니다: ${target}`);
  // GNU coreutils uses no-clobber rename on this same-filesystem path. Unlike
  // fs.rename, it cannot replace a concurrently created empty destination.
  const moved = spawnSync('mv', ['--no-clobber', '--no-target-directory', '--', stage, target], { encoding: 'utf8', shell: false });
  if (moved.error || moved.status !== 0 || exists(stage)) fail('새 목적지에 백업·복원 결과를 게시하지 못했습니다. 기존 경로는 교체하지 않습니다.');
  sync(dirname(target));
}
function guardedLock(dataDir) {
  if (process.env.TEAMSPACE_PILOT_LOCKED_DIR !== dataDir || process.env.TEAMSPACE_PILOT_LOCK_FD !== '9') fail('잠금 래퍼를 통해 실행해야 합니다.');
  const held = fstatSync(9), sibling = lstatSync(`${dataDir}.teamspace.lock`);
  if (!held.isFile() || !sibling.isFile() || sibling.isSymbolicLink() || held.dev !== sibling.dev || held.ino !== sibling.ino) fail('데이터 디렉터리 잠금 파일을 확인하지 못했습니다.');
  const stdio = Array(10).fill('ignore'); stdio[2] = 'pipe'; stdio[9] = 9;
  const lock = spawnSync('flock', ['-n', '-x', '9'], { stdio, shell: false });
  if (lock.error || lock.status !== 0) fail('데이터 디렉터리의 독점 잠금을 확보하지 못했습니다.', 75);
}
function perform(operation, source, target) {
  const { from, to } = paths(source, target);
  guardedLock(operation === 'backup' ? from : to);
  let stage;
  try {
    if (operation === 'backup') {
      credential(from); const databaseFd = regularFd(join(from, DB)); closeSync(databaseFd);
      const tree = walk(from);
      if (!tree.files.some(file => file.path === DB)) fail('Teamspace 데이터베이스가 없습니다.');
      stage = mkdtempSync(join(dirname(to), '.teamspace-backup-')); chmodSync(stage, 0o700);
      privateDirectory(join(stage, 'data')); copyTree(from, join(stage, 'data'), tree);
      const expected = validateDatabase(join(stage, 'data'), true);
      const manifest = manifestOf(join(stage, 'data'));
      verifyWorkspaceFiles(manifest, expected);
      writeFileSync(join(stage, MANIFEST), JSON.stringify(manifest), { flag: 'wx', mode: 0o600, flush: true });
      verifyBackup(stage);
      for (const directory of walk(stage).directories.reverse()) sync(join(stage, directory));
      publish(stage, to); stage = undefined;
      console.log(`백업 완료: ${to} (${manifest.files.length}개 파일${manifest.recoveryPending.length ? ` · 시작 시 복구 저널 ${manifest.recoveryPending.length}개 보존` : ''})`);
    } else {
      const originalManifest = verifyBackup(from);
      const payload = join(from, 'data'), tree = walk(payload);
      stage = mkdtempSync(join(dirname(to), '.teamspace-restore-')); chmodSync(stage, 0o700);
      copyTree(payload, stage, tree);
      const expected = validateDatabase(stage, false);
      clearReadonlyCaches(stage, originalManifest);
      const manifest = verifyBackup(from);
      verifyWorkspaceFiles(manifest, expected);
      for (const file of manifest.files) { const actual = digest(join(stage, file.path)); if (actual.size !== file.size || actual.sha256 !== file.sha256) fail('복원 사본의 무결성을 확인하지 못했습니다.'); }
      const copied = walk(stage);
      if (JSON.stringify(copied.directories) !== JSON.stringify([...manifest.directories].sort()) || JSON.stringify(copied.files.map(file => file.path)) !== JSON.stringify(manifest.files.map(file => file.path).sort())) fail('복원 사본에 매니페스트와 다른 파일 또는 디렉터리가 있습니다.');
      for (const directory of walk(stage).directories.reverse()) sync(join(stage, directory));
      publish(stage, to); stage = undefined;
      console.log(`복원 완료: ${to} · 운영 시작 전에 별도 경로에서 확인하세요.`);
    }
  } finally { if (stage) rmSync(stage, { recursive: true, force: true }); }
}

try {
  const args = process.argv.slice(2);
  if (args[0] === '__guarded' && args.length === 4 && ['backup', 'restore'].includes(args[1])) perform(args[1], args[2], args[3]);
  else if (args.length === 3 && ['backup', 'restore'].includes(args[0])) {
    const { from, to } = paths(args[1], args[2]), operation = args[0], lockDir = operation === 'backup' ? from : to;
    const child = spawnSync('bash', [WRAPPER, lockDir, process.execPath, SCRIPT, '__guarded', operation, from, to], { stdio: 'inherit', shell: false });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
  } else fail('사용법: node scripts/pilot-backup.mjs backup /abs/data-dir /abs/new-backup-dir\n또는: node scripts/pilot-backup.mjs restore /abs/backup-dir /abs/new-data-dir');
} catch (error) { console.error(`물리 백업·복원 실패: ${error.message}`); process.exitCode = error.exitCode ?? 1; }
