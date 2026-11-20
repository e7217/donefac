import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { LEGACY_MAX_RAW_BYTES } from '../server/legacy-import-archive.ts';
import { collectMigrationEvidence, compareMigrationEvidence } from './pilot-migration-evidence.mjs';
import { backupAndRestoreRehearsal, startRehearsalPilot } from './pilot-migration-runtime.mjs';

const runFormat = 'teamspace-migration-rehearsal';
const reportFormat = 'teamspace-migration-rehearsal-report';
const jsonLimit = 1024 * 1024;
const packageLimit = 20;
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/;
const sha256 = /^[a-f\d]{64}$/;
const products = new Set(['jira', 'confluence']);
const control = /[\x00-\x1f\x7f]/u;
const interruption = new AbortController();
const { signal } = interruption;

function interrupt(code) {
  if (signal.aborted) return;
  process.exitCode = code;
  interruption.abort(new Error('리허설 실행을 중단했습니다.'));
}

const onInterrupt = () => interrupt(130);
const onTerminate = () => interrupt(143);

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

async function readBoundedFile(path, limit) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const first = await file.stat({ bigint: true });
    if (!first.isFile() || first.size <= 0n || first.size > BigInt(limit)) {
      throw new Error('지원하는 크기의 일반 파일이 필요합니다.');
    }
    const bytes = Buffer.alloc(Number(first.size));
    for (let offset = 0; offset < bytes.length;) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error('읽는 동안 파일 크기가 바뀌었습니다.');
      offset += bytesRead;
    }
    const last = await file.stat({ bigint: true });
    if (last.size !== first.size || last.ctimeNs !== first.ctimeNs || last.mtimeNs !== first.mtimeNs) {
      throw new Error('읽는 동안 파일이 바뀌었습니다.');
    }
    return bytes;
  } finally { await file.close(); }
}

async function readJson(path, label) {
  let raw;
  try { raw = await readBoundedFile(path, jsonLimit); }
  catch (error) {
    signal.throwIfAborted();
    throw new Error(`${label} 파일을 읽을 수 없습니다 (${error.code ?? error.message}).`);
  }
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw new Error(`${label} JSON 형식을 확인해 주세요.`); }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx', flush: true });
}

function packageList(value) {
  return Array.isArray(value?.packages) && value.packages.length > 0 && value.packages.length <= packageLimit;
}

function sourceInstance(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !control.test(value);
}

async function loadManifest(path) {
  const manifest = await readJson(path, '이관 매니페스트');
  if (!packageList(manifest) || Object.keys(manifest).some(key => key !== 'packages')) {
    throw new Error('매니페스트의 packages에 원본 패키지를 1~20개 입력해 주세요.');
  }
  return manifest.packages.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 3 ||
        !products.has(item.product) || !sourceInstance(item.instanceKey) ||
        typeof item.file !== 'string' || !item.file.trim() || control.test(item.file)) {
      throw new Error(`패키지 ${index + 1}의 file, product, instanceKey 값을 확인해 주세요.`);
    }
    return { path: resolve(dirname(path), item.file), product: item.product, instanceKey: item.instanceKey.trim() };
  });
}

async function loadRun(directory) {
  const root = await realpath(directory);
  const state = await readJson(join(root, 'stage.json'), '리허설 기록');
  if (state?.format !== runFormat || state.version !== 1 || !packageList(state) ||
      state.packages.some(item => !item || !uuid.test(item.packageId) || !products.has(item.product) ||
        !sourceInstance(item.instanceKey) || !sha256.test(item.sha256) || !Number.isSafeInteger(item.size) ||
        item.size < 1 || item.size > LEGACY_MAX_RAW_BYTES)) {
    throw new Error('stage 명령이 만든 리허설 기록이 필요합니다.');
  }
  const workspace = join(root, 'workspace');
  if (!(await lstat(workspace)).isDirectory() || !(await lstat(join(workspace, 'teamspace.sqlite'))).isFile()) {
    throw new Error('리허설 워크스페이스를 확인해 주세요.');
  }
  return { root, workspace, packages: state.packages };
}

function apiCall(pilot) {
  return async (path, { statuses = [200], ...options } = {}) => {
    const response = await pilot.request(path, options);
    if (!statuses.includes(response.status)) {
      await response.body?.cancel();
      throw new Error(`파일럿 API 요청 실패 (${options.method ?? 'GET'} ${path.split('?')[0]}, HTTP ${response.status})`);
    }
    return response.json();
  };
}

async function withPilot(directory, action) {
  const pilot = await startRehearsalPilot(directory, { signal });
  try { return await action(apiCall(pilot)); }
  finally { await pilot.close(); }
}

async function stage(manifestPath, root) {
  const inputs = await loadManifest(manifestPath);
  await mkdir(root, { mode: 0o700 });
  try {
    const packages = await withPilot(join(root, 'workspace'), async call => {
      const actor = await call('/users', { method: 'POST', statuses: [201], body: { name: '이관 검토', email: 'migration-review@example.invalid' } });
      const results = [], namespacedHashes = new Set();
      for (const [index, input] of inputs.entries()) {
        let bytes;
        try { bytes = await readBoundedFile(input.path, LEGACY_MAX_RAW_BYTES); }
        catch (error) {
          signal.throwIfAborted();
          throw new Error(`패키지 ${index + 1} 파일을 읽을 수 없습니다 (${error.code ?? error.message}).`);
        }
        const sha = digest(bytes);
        const fingerprint = JSON.stringify([input.instanceKey, sha]);
        if (namespacedHashes.has(fingerprint)) throw new Error(`패키지 ${index + 1}과 동일한 원본이 매니페스트에 있습니다.`);
        namespacedHashes.add(fingerprint);
        const query = new URLSearchParams({ filename: basename(input.path), product: input.product, instanceKey: input.instanceKey });
        const summary = await call(`/legacy-import/packages?${query}`, { method: 'POST', statuses: [201], body: bytes,
          headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': actor.id } });
        if (summary.sha256 !== sha || summary.size !== bytes.length || !uuid.test(summary.id) ||
            summary.source.product !== input.product || summary.source.instanceKey !== input.instanceKey) {
          throw new Error(`패키지 ${index + 1}의 저장 결과와 입력 파일이 다릅니다.`);
        }
        results.push({ packageId: summary.id, product: input.product, instanceKey: input.instanceKey, sha256: sha, size: bytes.length,
          format: summary.source.format, errors: summary.errors, warnings: summary.warnings, counts: summary.counts });
        console.log(`원본 ${index + 1}/${inputs.length} 분석 완료 (${input.product}, 오류 ${summary.errors}, 경고 ${summary.warnings})`);
      }
      return results;
    });
    await writeJson(join(root, 'stage.json'), { format: runFormat, version: 1, createdAt: new Date().toISOString(), packages });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  console.log('검토할 워크스페이스를 준비했습니다. review 명령으로 열 수 있습니다.');
}

async function review(directory) {
  const { workspace } = await loadRun(directory);
  const pilot = await startRehearsalPilot(workspace, { signal });
  console.log(`이관 검토 주소 ${pilot.url}`);
  const { code, signal: stoppedBy, error } = await pilot.exited;
  signal.throwIfAborted();
  if (code !== 0) throw new Error(`이관 검토 워크스페이스가 종료되었습니다 (${error?.code ?? stoppedBy ?? code}).`);
}

async function verifyBundles(directory, packages) {
  const results = [];
  for (const item of packages) {
    signal.throwIfAborted();
    let status;
    try {
      const bytes = await readBoundedFile(join(directory, 'legacy-imports', `${item.packageId}.bundle`), LEGACY_MAX_RAW_BYTES);
      status = bytes.length === item.size && digest(bytes) === item.sha256 ? 'verified' : 'mismatch';
    } catch (error) {
      signal.throwIfAborted();
      status = error.code === 'ENOENT' ? 'missing' : 'unreadable';
    }
    results.push({ packageId: item.packageId, status });
  }
  return results;
}

async function inspectWorkspace(directory, packages) {
  return withPilot(directory, async call => {
    const bundles = await verifyBundles(directory, packages);
    const evidence = bundles.every(bundle => bundle.status === 'verified') ? await collectMigrationEvidence(call, packages) : null;
    return { bundles, evidence };
  });
}

async function verify(directory) {
  const { root, workspace, packages } = await loadRun(directory);
  const attempt = await mkdtemp(join(root, 'verification-'));
  const report = { format: reportFormat, version: 1, checkedAt: new Date().toISOString(), status: 'failed',
    source: null, restore: null, comparison: null };
  let step = 'source';
  try {
    report.source = await inspectWorkspace(workspace, packages);
    const evidence = report.source.evidence;
    if (evidence && evidence.status !== 'failed') {
      report.status = evidence.status;
      if (evidence.receipts.length) {
        step = 'backup';
        const restored = join(attempt, 'restored');
        await backupAndRestoreRehearsal(workspace, join(attempt, 'backup'), restored, { signal });
        step = 'restore';
        report.restore = await inspectWorkspace(restored, packages);
        if (report.restore.evidence) {
          report.comparison = compareMigrationEvidence(evidence, report.restore.evidence);
          report.status = report.comparison.status;
        } else report.status = 'failed';
      }
    }
  } catch (error) {
    report.status = 'failed';
    report.failedStep = step;
    throw error;
  } finally {
    await writeJson(join(attempt, 'report.json'), report);
    console.log(`검증 결과 ${basename(attempt)}/report.json (${report.status})`);
  }
  process.exitCode = report.status === 'verified' ? 0 : report.status === 'review' ? 2 : 1;
}

const usage = [
  'npm run pilot:rehearsal -- stage <manifest.json> <새 리허설 디렉터리>',
  'npm run pilot:rehearsal -- review <리허설 디렉터리>',
  'npm run pilot:rehearsal -- verify <리허설 디렉터리>',
].join('\n');

process.once('SIGINT', onInterrupt);
process.once('SIGTERM', onTerminate);
try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'stage' && args.length === 2) await stage(resolve(args[0]), resolve(args[1]));
  else if (command === 'review' && args.length === 1) await review(resolve(args[0]));
  else if (command === 'verify' && args.length === 1) await verify(resolve(args[0]));
  else if (!command || command === '--help') console.log(usage);
  else throw new Error(usage);
} catch (error) {
  if (!signal.aborted) {
    console.error(error.message);
    process.exitCode = 1;
  }
} finally {
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onTerminate);
}
