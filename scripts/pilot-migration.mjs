import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { safeFilename } from '../server/attachments.ts';
import { LEGACY_MAX_RAW_BYTES } from '../server/legacy-import-archive.ts';
import { collectMigrationEvidence, compareMigrationEvidence } from './pilot-migration-evidence.mjs';
import { backupAndRestoreRehearsal, startRehearsalPilot } from './pilot-migration-runtime.mjs';

const runFormat = 'teamspace-migration-rehearsal';
const reportFormat = 'teamspace-migration-rehearsal-report';
const profileFormat = 'teamspace-migration-source-profile';
const profileVersion = 2;
const jsonLimit = 1024 * 1024;
const packageLimit = 20;
const totalPackageBytes = 512 * 1024 * 1024;
const profileTimeout = 25_000;
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/;
const sha256 = /^[a-f\d]{64}$/;
const products = new Set(['jira', 'confluence']);
const profileStatuses = new Set(['analyzed', 'review']);
const formatsByProduct = { jira: new Set(['jira-backup-xml', 'jira-search-xml', 'jira-csv', 'jira-json']), confluence: new Set(['confluence-xml']) };
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

class BoundedFileError extends Error {
  constructor(reason, message) { super(message); this.reason = reason; }
}

async function withBoundedFile(path, limit, remaining, action) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const first = await file.stat({ bigint: true });
    if (!first.isFile() || first.size <= 0n || first.size > BigInt(limit)) {
      throw new BoundedFileError('FILE_NOT_SUPPORTED', '지원하는 크기의 일반 파일이 필요합니다.');
    }
    if (first.size > BigInt(remaining)) throw new BoundedFileError('TOTAL_SIZE_LIMIT', '원본 패키지 합계 크기를 초과했습니다.');
    return await action(file, first);
  } finally { await file.close(); }
}

async function readBoundedFile(path, limit, remaining = limit) {
  return withBoundedFile(path, limit, remaining, async (file, first) => {
    const bytes = Buffer.alloc(Number(first.size));
    for (let offset = 0; offset < bytes.length;) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new BoundedFileError('FILE_CHANGED', '읽는 동안 파일 크기가 바뀌었습니다.');
      offset += bytesRead;
    }
    const last = await file.stat({ bigint: true });
    if (last.size !== first.size || last.ctimeNs !== first.ctimeNs || last.mtimeNs !== first.mtimeNs) {
      throw new BoundedFileError('FILE_CHANGED', '읽는 동안 파일이 바뀌었습니다.');
    }
    return bytes;
  });
}

async function readJsonFile(path, label) {
  let raw;
  try { raw = await readBoundedFile(path, jsonLimit); }
  catch (error) {
    signal.throwIfAborted();
    throw new Error(`${label} 파일을 읽을 수 없습니다 (${error.code ?? error.message}).`);
  }
  try { return { data: JSON.parse(raw.toString('utf8')), sha256: digest(raw) }; }
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
  const { data: manifest } = await readJsonFile(path, '이관 매니페스트');
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

function packageFilename(path) {
  try { return safeFilename(basename(path)); }
  catch { throw new BoundedFileError('FILE_NOT_SUPPORTED', '원본 파일명을 확인해 주세요.'); }
}

function packageInputSha256(input, ordinal, filename, bytes) {
  // Loose XML basenames such as entities.xml affect analysis, while an outer ZIP name does not.
  const fileKind = /\.zip$/iu.test(filename) ? ['zip'] : ['loose', filename];
  const context = JSON.stringify([profileFormat, profileVersion, ordinal, input.product, input.instanceKey, fileKind]);
  return createHash('sha256').update(context).update('\0').update(bytes).digest('hex');
}

function isSha256(value) { return typeof value === 'string' && sha256.test(value); }
function isCount(value) { return Number.isSafeInteger(value) && value >= 0; }

function validProfileProof(proof) {
  return proof?.version === profileVersion && profileStatuses.has(proof.status) && isSha256(proof.sha256) &&
    typeof proof.checkedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(proof.checkedAt) &&
    Number.isFinite(Date.parse(proof.checkedAt));
}

function profileMismatch(index, reason) {
  return new Error(`패키지 ${index + 1}이(가) 원본 분석 보고서와 다릅니다 (${reason}). 매니페스트를 확인하고 profile을 다시 실행해 주세요.`);
}

async function loadStageProfile(path, inputs) {
  const { data: report, sha256 } = await readJsonFile(path, '원본 분석 보고서');
  if (report?.format !== profileFormat || report.version !== profileVersion || !packageList(report)) {
    throw new Error('현재 형식의 원본 분석 보고서가 필요합니다. profile을 다시 실행해 주세요.');
  }
  if (report.status === 'blocked' || report.packages.some(item => item?.status === 'blocked')) {
    throw new Error('중단된 원본 분석 보고서입니다 (blocked). 원본의 오류를 해결하고 profile을 다시 실행해 주세요.');
  }
  const proof = { version: report.version, status: report.status, checkedAt: report.checkedAt, sha256 };
  if (!validProfileProof(proof)) throw new Error('원본 분석 보고서의 상태와 분석 시각을 확인해 주세요.');
  if (report.packages.length !== inputs.length) {
    throw new Error('매니페스트의 패키지 수가 원본 분석 보고서와 다릅니다. profile을 다시 실행해 주세요.');
  }
  const totals = { packages: inputs.length, analyzed: 0, review: 0, blocked: 0, bytes: 0 };
  const packages = report.packages.map((item, index) => {
    if (item?.ordinal !== index + 1 || item.product !== inputs[index].product) {
      throw profileMismatch(index, '순서 또는 원본 제품');
    }
    const { format, fileCount, expandedBytes, counts, diagnostics } = item.analysis ?? {};
    if (!profileStatuses.has(item.status) || !isSha256(item.sha256) || !isSha256(item.inputSha256) ||
        !isCount(item.size) || !item.size || item.size > LEGACY_MAX_RAW_BYTES || !formatsByProduct[item.product].has(format) ||
        !isCount(fileCount) || !isCount(expandedBytes) || !counts || typeof counts !== 'object' || Array.isArray(counts) ||
        !Object.values(counts).every(isCount) || !Array.isArray(diagnostics) || diagnostics.some(row =>
          !['info', 'warning'].includes(row?.severity) || !isCount(row.count) || row.count === 0)) {
      throw new Error(`패키지 ${index + 1}의 원본 분석 결과를 확인할 수 없습니다. profile을 다시 실행해 주세요.`);
    }
    const warnings = diagnostics.reduce((total, row) => total + (row.severity === 'warning' ? row.count : 0), 0);
    if (!isCount(warnings) || (item.status === 'analyzed' && warnings > 0)) {
      throw new Error(`패키지 ${index + 1}의 원본 분석 경고를 확인할 수 없습니다. profile을 다시 실행해 주세요.`);
    }
    totals[item.status]++;
    totals.bytes += item.size;
    return { size: item.size, sha256: item.sha256, inputSha256: item.inputSha256, format, fileCount, expandedBytes, counts, warnings };
  });
  if (totals.bytes > totalPackageBytes || (totals.review ? 'review' : 'analyzed') !== report.status ||
      Object.entries(totals).some(([key, value]) => report.totals?.[key] !== value)) {
    throw new Error('원본 분석 보고서의 합계나 상태가 패키지 결과와 일치하지 않습니다. profile을 다시 실행해 주세요.');
  }
  return { proof, packages };
}

async function loadRun(directory) {
  const root = await realpath(directory);
  const { data: state } = await readJsonFile(join(root, 'stage.json'), '리허설 기록');
  if (state?.format !== runFormat || state.version !== 1 || !packageList(state) ||
      (Object.hasOwn(state, 'profile') && !validProfileProof(state.profile)) ||
      state.packages.some(item => !item || !uuid.test(item.packageId) || !products.has(item.product) ||
        !sourceInstance(item.instanceKey) || !sha256.test(item.sha256) || !Number.isSafeInteger(item.size) ||
        item.size < 1 || item.size > LEGACY_MAX_RAW_BYTES)) {
    throw new Error('stage 명령이 만든 리허설 기록이 필요합니다.');
  }
  const workspace = join(root, 'workspace');
  if (!(await lstat(workspace)).isDirectory() || !(await lstat(join(workspace, 'teamspace.sqlite'))).isFile()) {
    throw new Error('리허설 워크스페이스를 확인해 주세요.');
  }
  return { root, workspace, packages: state.packages, profile: state.profile };
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

function analyzeProfile(input, filename, bytes) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    // Buffer.alloc in the bounded reader owns its buffer. The worker receives exactly the bytes already hashed.
    const worker = new Worker(new URL('./pilot-migration-profile-worker.mjs', import.meta.url), {
      workerData: { bytes, filename, product: input.product, instanceKey: input.instanceKey },
      transferList: [bytes.buffer], execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 },
    });
    let done = false;
    function finish(result, aborted = false) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      void worker.terminate();
      if (aborted) reject(signal.reason);
      else resolve(result);
    }
    const abort = () => finish(null, true);
    const timer = setTimeout(() => finish({ status: 'blocked', failure: 'ANALYSIS_TIMEOUT' }), profileTimeout);
    signal.addEventListener('abort', abort, { once: true });
    worker.once('message', result => finish(result));
    worker.once('error', error => finish({ status: 'blocked', failure: error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'ANALYSIS_LIMIT' : 'ANALYSIS_UNAVAILABLE' }));
    worker.once('exit', () => finish({ status: 'blocked', failure: 'ANALYSIS_UNAVAILABLE' }));
  });
}

async function profile(manifestPath, outputPath) {
  const inputs = await loadManifest(manifestPath);
  const packages = [], namespacedHashes = new Set();
  const totals = { packages: inputs.length, analyzed: 0, review: 0, blocked: 0, bytes: 0 };
  for (const [index, input] of inputs.entries()) {
    signal.throwIfAborted();
    const item = { ordinal: index + 1, product: input.product };
    let result;
    try {
      const filename = packageFilename(input.path);
      const bytes = await readBoundedFile(input.path, LEGACY_MAX_RAW_BYTES, totalPackageBytes - totals.bytes);
      item.size = bytes.length;
      item.sha256 = digest(bytes);
      totals.bytes += item.size;
      const fingerprint = JSON.stringify([input.instanceKey, item.sha256]);
      if (namespacedHashes.has(fingerprint)) result = { status: 'blocked', failure: 'DUPLICATE_PACKAGE' };
      else {
        namespacedHashes.add(fingerprint);
        const inputSha256 = packageInputSha256(input, item.ordinal, filename, bytes);
        try { result = await analyzeProfile(input, filename, bytes); }
        catch { signal.throwIfAborted(); result = { status: 'blocked', failure: 'ANALYSIS_UNAVAILABLE' }; }
        if (profileStatuses.has(result.status)) item.inputSha256 = inputSha256;
      }
    } catch (error) {
      signal.throwIfAborted();
      result = { status: 'blocked', failure: error instanceof BoundedFileError ? error.reason
        : ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'FILE_NOT_FOUND' : 'FILE_UNREADABLE' };
    }
    packages.push({ ...item, ...result });
    totals[result.status]++;
  }
  const status = totals.blocked ? 'blocked' : totals.review ? 'review' : 'analyzed';
  const report = { format: profileFormat, version: profileVersion, checkedAt: new Date().toISOString(), status,
    limits: { packageCount: packageLimit, packageBytes: LEGACY_MAX_RAW_BYTES, totalBytes: totalPackageBytes }, totals, packages };
  signal.throwIfAborted();
  try { await writeJson(outputPath, report); }
  catch (error) {
    throw new Error(error.code === 'EEXIST' ? '이미 있는 파일에는 원본 분석 보고서를 저장할 수 없습니다.' : '원본 분석 보고서 파일을 저장할 수 없습니다.');
  }
  console.log(`원본 분석 보고서를 저장했습니다 (${status}).`);
  process.exitCode = status === 'analyzed' ? 0 : status === 'review' ? 2 : 1;
}

function stageFileError(index, error) {
  signal.throwIfAborted();
  return new Error(`패키지 ${index + 1} 파일을 읽을 수 없습니다 (${error.code ?? error.message}).`);
}

async function preflightStageInputs(inputs, expected) {
  const filenames = [];
  let remaining = totalPackageBytes;
  for (const [index, input] of inputs.entries()) {
    signal.throwIfAborted();
    let size;
    try {
      filenames.push(packageFilename(input.path));
      size = await withBoundedFile(input.path, LEGACY_MAX_RAW_BYTES, remaining, (_file, stat) => Number(stat.size));
    } catch (error) { throw stageFileError(index, error); }
    if (expected && size !== expected[index].size) throw profileMismatch(index, '파일 크기');
    remaining -= size;
  }
  return filenames;
}

function matchesProfileAnalysis(summary, expected) {
  return summary.source.format === expected.format && summary.errors === 0 && summary.warnings === expected.warnings &&
    summary.fileCount === expected.fileCount && summary.expandedBytes === expected.expandedBytes &&
    Object.entries(expected.counts).every(([kind, count]) => count === (summary.counts[kind] ?? 0)) &&
    Object.entries(summary.counts).every(([kind, count]) => count === (expected.counts[kind] ?? 0));
}

async function stage(manifestPath, root, profilePath) {
  const inputs = await loadManifest(manifestPath);
  const profiled = profilePath ? await loadStageProfile(profilePath, inputs) : null;
  const filenames = await preflightStageInputs(inputs, profiled?.packages);
  signal.throwIfAborted();
  await mkdir(root, { mode: 0o700 });
  try {
    const packages = await withPilot(join(root, 'workspace'), async call => {
      const actor = await call('/users', { method: 'POST', statuses: [201], body: { name: '이관 검토', email: 'migration-review@example.invalid' } });
      const results = [], namespacedHashes = new Set();
      let remaining = totalPackageBytes;
      for (const [index, input] of inputs.entries()) {
        let bytes;
        try { bytes = await readBoundedFile(input.path, LEGACY_MAX_RAW_BYTES, remaining); }
        catch (error) { throw stageFileError(index, error); }
        remaining -= bytes.length;
        const filename = filenames[index], expected = profiled?.packages[index];
        const sha = digest(bytes);
        if (expected && (bytes.length !== expected.size || sha !== expected.sha256)) throw profileMismatch(index, '파일 SHA-256 또는 크기');
        if (expected && packageInputSha256(input, index + 1, filename, bytes) !== expected.inputSha256) {
          throw profileMismatch(index, '원본 인스턴스 또는 파일 유형과 이름');
        }
        const fingerprint = JSON.stringify([input.instanceKey, sha]);
        if (namespacedHashes.has(fingerprint)) throw new Error(`패키지 ${index + 1}과 동일한 원본이 매니페스트에 있습니다.`);
        namespacedHashes.add(fingerprint);
        const query = new URLSearchParams({ filename, product: input.product, instanceKey: input.instanceKey });
        const summary = await call(`/legacy-import/packages?${query}`, { method: 'POST', statuses: [201], body: bytes,
          headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': actor.id } });
        if (summary.sha256 !== sha || summary.size !== bytes.length || !uuid.test(summary.id) ||
            summary.source.product !== input.product || summary.source.instanceKey !== input.instanceKey) {
          throw new Error(`패키지 ${index + 1}의 저장 결과와 입력 파일이 다릅니다.`);
        }
        if (expected && !matchesProfileAnalysis(summary, expected)) throw profileMismatch(index, '분석 형식·건수 또는 경고');
        results.push({ packageId: summary.id, product: input.product, instanceKey: input.instanceKey, sha256: sha, size: bytes.length,
          format: summary.source.format, errors: summary.errors, warnings: summary.warnings, counts: summary.counts });
        console.log(`원본 ${index + 1}/${inputs.length} 분석 완료 (${input.product}, 오류 ${summary.errors}, 경고 ${summary.warnings})`);
      }
      return results;
    });
    signal.throwIfAborted();
    await writeJson(join(root, 'stage.json'), { format: runFormat, version: 1, createdAt: new Date().toISOString(), packages,
      ...(profiled ? { profile: profiled.proof } : {}) });
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
  const { root, workspace, packages, profile } = await loadRun(directory);
  const attempt = await mkdtemp(join(root, 'verification-'));
  const report = { format: reportFormat, version: 1, checkedAt: new Date().toISOString(), status: 'failed',
    source: null, restore: null, comparison: null, ...(profile ? { profile } : {}) };
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
  'npm run pilot:rehearsal -- profile <manifest.json> <새 분석 보고서.json>',
  'npm run pilot:rehearsal -- stage <manifest.json> <새 리허설 디렉터리> [--profile <분석 보고서.json>]',
  'npm run pilot:rehearsal -- review <리허설 디렉터리>',
  'npm run pilot:rehearsal -- verify <리허설 디렉터리>',
].join('\n');

process.once('SIGINT', onInterrupt);
process.once('SIGTERM', onTerminate);
try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'profile' && args.length === 2) await profile(resolve(args[0]), resolve(args[1]));
  else if (command === 'stage' && (args.length === 2 || (args.length === 4 && args[2] === '--profile'))) {
    await stage(resolve(args[0]), resolve(args[1]), args.length === 4 ? resolve(args[3]) : undefined);
  }
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
