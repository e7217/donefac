import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Worker } from 'node:worker_threads';
import { safeFilename } from '../server/attachments.ts';
import { LEGACY_MAX_RAW_BYTES } from '../server/legacy-import-archive.ts';
import { PILOT_REHEARSAL_DIRECTORY } from '../server/pilot-rehearsal.ts';
import { readConfluenceArchivePageIds } from './confluence-pilot-audit-archive.mjs';
import { JIRA_COLLECTION_PLAN_MAX_BYTES, parseJiraCollectionPlan } from './jira-pilot-collect-plan.mjs';
import { collectMigrationEvidence, compareMigrationEvidence } from './pilot-migration-evidence.mjs';
import { CONFLUENCE_FINDINGS_MAX_BYTES, CONFLUENCE_FINDINGS_VERSION, combinedConfluenceCoverage, confirmedConfluenceEditRestrictions, confirmedConfluenceRestrictions,
  confluenceFindingsProof, parseConfluenceFindings, validConfluenceFindingsProof } from './pilot-migration-confluence-findings.mjs';
import { createJiraPlanCoverage } from './pilot-migration-jira-plan.mjs';
import { backupAndRestoreRehearsal, startRehearsalPilot } from './pilot-migration-runtime.mjs';

const runFormat = 'donefac-migration-rehearsal';
const reportFormat = 'donefac-migration-rehearsal-report';
const profileFormat = 'donefac-migration-source-profile';
const profileVersion = 2;
const jsonLimit = 1024 * 1024;
const packageLimit = 20;
const totalPackageBytes = 512 * 1024 * 1024;
const confluenceFindingsLimit = 100;
const totalConfluenceFindingsBytes = 128 * 1024 * 1024;
const findingsDirectory = 'confluence-findings';
const jiraPlansDirectory = 'jira-plans';
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

async function withBoundedFile(path, limit, remaining, action, flags = 0) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | flags);
  try {
    const first = await file.stat({ bigint: true });
    if (!first.isFile() || first.size <= 0n || first.size > BigInt(limit)) {
      throw new BoundedFileError('FILE_NOT_SUPPORTED', '지원하는 크기의 일반 파일이 필요합니다.');
    }
    if (first.size > BigInt(remaining)) throw new BoundedFileError('TOTAL_SIZE_LIMIT', '원본 패키지 합계 크기를 초과했습니다.');
    return await action(file, first);
  } finally { await file.close(); }
}

async function readBoundedFile(path, limit, remaining = limit, flags = 0) {
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
  }, flags);
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
          !['info', 'warning', 'error'].includes(row?.severity) || !isCount(row.count) || row.count === 0 ||
          row.severity === 'error' && (item.status !== 'review' || item.product !== 'confluence' || !isMarkedRestriction(row)))) {
      throw new Error(`패키지 ${index + 1}의 원본 분석 결과를 확인할 수 없습니다. profile을 다시 실행해 주세요.`);
    }
    const errors = diagnostics.reduce((total, row) => total + (row.severity === 'error' ? row.count : 0), 0);
    const warnings = diagnostics.reduce((total, row) => total + (row.severity === 'warning' ? row.count : 0), 0);
    if (!isCount(errors) || !isCount(warnings) || (item.status === 'analyzed' && warnings > 0)) {
      throw new Error(`패키지 ${index + 1}의 원본 분석 진단을 확인할 수 없습니다. profile을 다시 실행해 주세요.`);
    }
    totals[item.status]++;
    totals.bytes += item.size;
    return { size: item.size, sha256: item.sha256, inputSha256: item.inputSha256, format, fileCount, expandedBytes, counts, errors, warnings };
  });
  if (totals.bytes > totalPackageBytes || (totals.review ? 'review' : 'analyzed') !== report.status ||
      Object.entries(totals).some(([key, value]) => report.totals?.[key] !== value)) {
    throw new Error('원본 분석 보고서의 합계나 상태가 패키지 결과와 일치하지 않습니다. profile을 다시 실행해 주세요.');
  }
  return { proof, packages };
}

async function readConfluenceFindingsBytes(path, remaining) {
  try { return await readBoundedFile(path, CONFLUENCE_FINDINGS_MAX_BYTES, remaining); }
  catch {
    signal.throwIfAborted();
    throw new Error('Confluence 페이지별 검토 파일을 읽을 수 없습니다. 파일과 크기를 확인해 주세요.');
  }
}

function readConfluenceFindings(raw) {
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
  catch { throw new Error('Confluence 페이지별 검토 파일의 JSON 형식을 확인해 주세요.'); }
  return parseConfluenceFindings(value);
}

async function loadStageFindings(paths) {
  const results = [];
  const hashes = new Set();
  let remaining = totalConfluenceFindingsBytes;
  for (const path of paths) {
    const raw = await readConfluenceFindingsBytes(path, remaining);
    remaining -= raw.length;
    const sha256 = digest(raw);
    if (hashes.has(sha256)) throw new Error('동일한 Confluence 페이지별 검토 파일이 중복되었습니다.');
    hashes.add(sha256);
    const findings = readConfluenceFindings(raw);
    const proof = confluenceFindingsProof(findings, sha256, null);
    const { version, coverage, permissionCheckedPageIds } = findings;
    results.push({ path, proof, findings: { version, coverage, permissionCheckedPageIds } });
  }
  return results;
}

function matchConfluenceArchive(archive, packages) {
  const matches = packages.filter(item => item.product === 'confluence' && item.format === 'confluence-xml' &&
    item.sha256 === archive.sha256 && item.size === archive.bytes);
  if (!matches.length) throw new Error('Confluence 페이지별 검토 파일과 일치하는 XML ZIP 패키지가 없습니다.');
  if (matches.length > 1) throw new Error('Confluence 페이지별 검토 파일과 일치하는 XML ZIP 패키지가 여러 개입니다.');
  return matches[0];
}

async function saveStageFindings(root, reports, packages) {
  const bound = reports.map(({ path, proof, findings }) => ({
    path, proof: { ...proof, packageId: matchConfluenceArchive(proof.archive, packages).packageId }, findings,
  }));
  const directory = join(root, findingsDirectory);
  await mkdir(directory, { mode: 0o700 });
  let remaining = totalConfluenceFindingsBytes;
  for (const { path, proof } of bound) {
    const raw = await readConfluenceFindingsBytes(path, remaining);
    remaining -= raw.length;
    if (digest(raw) !== proof.sha256) throw new Error('읽는 동안 Confluence 페이지별 검토 파일이 바뀌었습니다.');
    await writeFile(join(directory, `${proof.sha256}.json`), raw, { mode: 0o600, flag: 'wx', flush: true });
  }
  return bound.map(({ proof, findings }) => ({ proof, findings }));
}

async function loadRunFindings(root, proofs, packages) {
  if (!Array.isArray(proofs) || proofs.length < 1 || proofs.length > confluenceFindingsLimit ||
      !proofs.every(validConfluenceFindingsProof) || new Set(proofs.map(proof => proof.sha256)).size !== proofs.length) {
    throw new Error('리허설의 Confluence 페이지별 검토 기록을 확인해 주세요.');
  }
  const reviews = [];
  let remaining = totalConfluenceFindingsBytes;
  for (const proof of proofs) {
    if (matchConfluenceArchive(proof.archive, packages).packageId !== proof.packageId) {
      throw new Error('Confluence 페이지별 검토 파일과 리허설의 원본 패키지 연결이 다릅니다.');
    }
    const raw = await readConfluenceFindingsBytes(join(root, findingsDirectory, `${proof.sha256}.json`), remaining);
    remaining -= raw.length;
    if (digest(raw) !== proof.sha256) throw new Error('보관한 Confluence 페이지별 검토 파일의 SHA-256이 다릅니다.');
    const findings = readConfluenceFindings(raw);
    if (!isDeepStrictEqual(confluenceFindingsProof(findings, proof.sha256, proof.packageId), proof)) {
      throw new Error('보관한 Confluence 페이지별 검토 파일과 리허설 기록이 다릅니다.');
    }
    reviews.push({ proof, findings });
  }
  return reviews;
}

async function readJiraPlanFile(path) {
  let raw;
  try { raw = await readBoundedFile(path, JIRA_COLLECTION_PLAN_MAX_BYTES); }
  catch {
    signal.throwIfAborted();
    throw new Error('Jira 수집 계획 파일을 읽을 수 없습니다. 파일과 크기를 확인해 주세요.');
  }
  return { raw, plan: parseJiraCollectionPlan(raw) };
}

async function saveJiraPlanFiles(root, inputs) {
  const directory = join(root, jiraPlansDirectory);
  await mkdir(directory, { mode: 0o700 });
  for (const { raw, plan } of inputs) {
    await writeFile(join(directory, `${plan.sha256}.json`), raw, { mode: 0o600, flag: 'wx', flush: true });
  }
}

async function loadRunJiraPlans(root, proofs, packages) {
  const eligiblePackages = new Set(packages.filter(item => item.product === 'jira' && item.format === 'jira-json').map(item => item.packageId));
  const invalid = '리허설의 Jira 수집 계획 기록을 확인해 주세요.';
  if (!Array.isArray(proofs) || !proofs.length || proofs.length > packageLimit) throw new Error(invalid);
  const planHashes = new Set(), packageIds = new Set(), results = [];
  for (const proof of proofs) {
    if (!proof || Object.keys(proof).length !== 4 || !isSha256(proof.sha256) || planHashes.has(proof.sha256) ||
        !isCount(proof.issueCount) || !Array.isArray(proof.packageIds) || !proof.packageIds.length ||
        proof.batchCount !== proof.packageIds.length || proof.batchCount > packageLimit) throw new Error(invalid);
    planHashes.add(proof.sha256);
    for (const id of proof.packageIds) {
      if (!eligiblePackages.has(id) || packageIds.has(id)) throw new Error(invalid);
      packageIds.add(id);
    }
    const { plan } = await readJiraPlanFile(join(root, jiraPlansDirectory, `${proof.sha256}.json`));
    if (plan.sha256 !== proof.sha256 || plan.issueCount !== proof.issueCount || plan.batches.length !== proof.batchCount) {
      throw new Error('보관한 Jira 수집 계획의 SHA-256 또는 범위가 리허설 기록과 다릅니다.');
    }
    results.push({ plan, proof });
  }
  return results;
}

async function embeddedRunDirectory(workspace) {
  const path = join(workspace, PILOT_REHEARSAL_DIRECTORY);
  const entry = await lstat(path).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!entry) return undefined;
  if (!entry.isDirectory()) throw new Error('리허설 기록 디렉터리를 확인해 주세요.');
  return path;
}

async function loadRun(directory) {
  const input = await realpath(directory);
  const direct = await embeddedRunDirectory(input);
  const root = direct ? dirname(input) : input;
  const workspace = direct ? input : join(input, 'workspace');
  if (!(await lstat(workspace)).isDirectory() || !(await lstat(join(workspace, 'donefac.sqlite'))).isFile()) {
    throw new Error('리허설 워크스페이스를 확인해 주세요.');
  }
  const embedded = direct ?? await embeddedRunDirectory(workspace);
  const stateDirectory = embedded ?? root;
  const { data: state, sha256: stageSha256 } = await readJsonFile(join(stateDirectory, 'stage.json'), '리허설 기록');
  if (state?.format !== runFormat || state.version !== 1 || !packageList(state) ||
      (Object.hasOwn(state, 'profile') && !validProfileProof(state.profile)) ||
      state.packages.some(item => !item || !uuid.test(item.packageId) || !products.has(item.product) ||
        !sourceInstance(item.instanceKey) || !sha256.test(item.sha256) || !Number.isSafeInteger(item.size) ||
        item.size < 1 || item.size > LEGACY_MAX_RAW_BYTES)) {
    throw new Error('stage 명령이 만든 리허설 기록이 필요합니다.');
  }
  const confluenceReviews = Object.hasOwn(state, 'confluenceReviews')
    ? await loadRunFindings(stateDirectory, state.confluenceReviews, state.packages) : [];
  const jiraPlans = Object.hasOwn(state, 'jiraPlans') ? await loadRunJiraPlans(stateDirectory, state.jiraPlans, state.packages) : [];
  return { input, root, workspace, embedded: Boolean(embedded), stageSha256,
    packages: state.packages, profile: state.profile, confluenceReviews, jiraPlans };
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

async function withPilot(directory, action, reviewOptions) {
  const pilot = await startRehearsalPilot(directory, { signal, ...reviewOptions });
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
  return summary.source.format === expected.format && summary.errors === expected.errors && summary.warnings === expected.warnings &&
    summary.fileCount === expected.fileCount && summary.expandedBytes === expected.expandedBytes &&
    Object.entries(expected.counts).every(([kind, count]) => count === (summary.counts[kind] ?? 0)) &&
    Object.entries(summary.counts).every(([kind, count]) => count === (expected.counts[kind] ?? 0));
}

function isMarkedRestriction(row) {
  return row.code === 'CONFLUENCE_RESTRICTED_CONTENT';
}

async function matchesProfileErrors(call, summary) {
  // The summary counts errors, but the staged diagnostics establish which records are restricted.
  const limit = 100;
  const records = new Set();
  for (let offset = 0; offset < summary.errors; offset += limit) {
    const page = await call(`/legacy-import/packages/${summary.id}/diagnostics?severity=error&offset=${offset}&limit=${limit}`);
    if (page?.total !== summary.errors || page.offset !== offset || page.limit !== limit || !Array.isArray(page.diagnostics) ||
        page.diagnostics.length !== Math.min(limit, summary.errors - offset)) return false;
    for (const row of page.diagnostics) {
      if (row?.severity !== 'error' || !isMarkedRestriction(row) || typeof row.recordId !== 'string' || !row.recordId || records.has(row.recordId)) return false;
      records.add(row.recordId);
    }
  }
  return true;
}

async function stage(manifestPath, root, { profilePath, findingsPaths, jiraPlanPaths }) {
  const inputs = await loadManifest(manifestPath);
  const profiled = profilePath ? await loadStageProfile(profilePath, inputs) : null;
  const findings = await loadStageFindings(findingsPaths);
  const jiraPlanFiles = [];
  for (const path of jiraPlanPaths) jiraPlanFiles.push(await readJiraPlanFile(path));
  const jiraCoverage = jiraPlanFiles.length ? createJiraPlanCoverage(jiraPlanFiles.map(({ plan }) => plan)) : null;
  const filenames = await preflightStageInputs(inputs, profiled?.packages);
  const confluenceZips = inputs.map((input, index) => input.product === 'confluence' && /\.zip$/iu.test(filenames[index]));
  if (findings.length && !confluenceZips.includes(true)) {
    throw new Error('Confluence 페이지별 검토 파일과 일치하는 XML ZIP 패키지가 없습니다.');
  }
  signal.throwIfAborted();
  await mkdir(root, { mode: 0o700 });
  try {
    const workspace = join(root, 'workspace');
    const stateDirectory = join(workspace, PILOT_REHEARSAL_DIRECTORY);
    await mkdir(workspace, { mode: 0o700 });
    await mkdir(stateDirectory, { mode: 0o700 });
    await withPilot(workspace, async call => {
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
        if (expected && (!matchesProfileAnalysis(summary, expected) || !await matchesProfileErrors(call, summary))) {
          throw profileMismatch(index, '분석 형식·건수 또는 진단');
        }
        const staged = { packageId: summary.id, product: input.product, instanceKey: input.instanceKey, sha256: sha, size: bytes.length,
          format: summary.source.format, errors: summary.errors, warnings: summary.warnings, counts: summary.counts };
        await jiraCoverage?.addPackage(staged, bytes);
        results.push(staged);
        console.log(`원본 ${index + 1}/${inputs.length} 분석 완료 (${input.product}, 오류 ${summary.errors}, 경고 ${summary.warnings})`);
      }
      signal.throwIfAborted();
      const confluenceReviews = findings.length
        ? await saveStageFindings(stateDirectory, findings, results.filter((_item, index) => confluenceZips[index])) : [];
      await verifiedConfluenceCoverage(workspace, results, confluenceReviews);
      const jiraPlans = jiraCoverage?.finish();
      if (jiraPlans) await saveJiraPlanFiles(stateDirectory, jiraPlanFiles);
      await writeJson(join(stateDirectory, 'stage.json'), { format: runFormat, version: 1, createdAt: new Date().toISOString(), packages: results,
        ...(profiled ? { profile: profiled.proof } : {}),
        ...(confluenceReviews.length ? { confluenceReviews: confluenceReviews.map(({ proof }) => proof) } : {}),
        ...(jiraPlans ? { jiraPlans } : {}) });
    });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  console.log('검토할 워크스페이스를 준비했습니다. review 명령으로 열 수 있습니다.');
}

function pilotReviewOptions(packages, confluenceReviews, coverage = []) {
  const toScope = records => [...records].map(([instanceKey, pages]) => [instanceKey, [...pages]]);
  const restrictions = toScope(confirmedConfluenceRestrictions(confluenceReviews, packages));
  const editRestrictions = toScope(confirmedConfluenceEditRestrictions(confluenceReviews, packages));
  const reviews = confluenceReviews.map(({ proof }) => ({
    packageId: proof.packageId, archiveSha256: proof.archive.sha256, archiveBytes: proof.archive.bytes,
    checkedAt: proof.checkedAt, selection: proof.selection, status: proof.status, spacePermissions: proof.spacePermissions,
    findingsPages: proof.pageCount, unidentifiedPages: proof.unidentifiedPages,
    ...(proof.reasonCounts.LIVE_EDIT_RESTRICTED ? { editRestrictedPages: proof.reasonCounts.LIVE_EDIT_RESTRICTED } : {}),
    ...(proof.coverage ? { coverage: proof.coverage } : {}),
  }));
  return { restrictions, reviews, coverage, editRestrictions };
}

async function review(directory) {
  const { workspace, packages, confluenceReviews, jiraPlans } = await loadRun(directory);
  const reviewedIds = new Set(confluenceReviews.map(({ proof }) => proof.packageId));
  const reviewedPackages = packages.filter(pkg => reviewedIds.has(pkg.packageId));
  const coverage = await verifiedConfluenceCoverage(workspace, reviewedPackages, confluenceReviews);
  const pilot = await startRehearsalPilot(workspace, { signal, ...pilotReviewOptions(reviewedPackages, confluenceReviews, coverage) });
  try {
    // Check preparation against the open workspace while the pilot holds its data lock.
    const staged = new Map((await apiCall(pilot)('/legacy-import/packages')).map(item => [item.id, item]));
    for (const [index, pkg] of packages.entries()) {
      const current = staged.get(pkg.packageId);
      if (current?.sha256 !== pkg.sha256 || current.size !== pkg.size || current.source?.product !== pkg.product ||
          current.source?.format !== pkg.format || current.source?.instanceKey !== pkg.instanceKey) {
        throw new Error(`원본 패키지 ${index + 1}번의 분석 기록과 원본 인스턴스가 일치하지 않습니다.`);
      }
    }
    const { bundles } = await verifyBundles(workspace, packages, [], jiraPlans);
    const bundleProblem = {
      missing: '보관한 원본 파일이 없습니다.',
      unreadable: '보관한 원본 파일을 읽을 수 없습니다.',
      mismatch: '원본 파일의 크기 또는 SHA-256이 리허설 기록과 다릅니다.',
    };
    for (const [index, bundle] of bundles.entries()) {
      if (bundle.status !== 'verified') throw new Error(`원본 패키지 ${index + 1}번을 검토할 수 없습니다. ${bundleProblem[bundle.status]}`);
    }
    console.log(`이관 검토 주소 ${pilot.url}`);
    if (confluenceReviews.length) console.log(`Confluence 페이지별 검토 파일 ${confluenceReviews.length}개를 불러왔습니다.`);
    if (jiraPlans.length) console.log(`Jira 수집 계획 ${jiraPlans.length}개의 전체 묶음을 확인했습니다.`);
    const { code, signal: stoppedBy, error } = await pilot.exited;
    signal.throwIfAborted();
    if (code !== 0) throw new Error(`이관 검토 워크스페이스가 종료되었습니다 (${error?.code ?? stoppedBy ?? code}).`);
  } catch (error) {
    await pilot.close().catch(() => {});
    throw error;
  }
}

function exactCoveragePackageIds(reviews) {
  return new Set(reviews.filter(({ proof }) => proof.version === CONFLUENCE_FINDINGS_VERSION).map(({ proof }) => proof.packageId));
}

async function verifyBundles(directory, packages, confluenceReviews = [], jiraPlans = []) {
  const bundles = [], archivePageIds = new Map();
  const exactReviews = exactCoveragePackageIds(confluenceReviews);
  const jiraCoverage = jiraPlans.length ? createJiraPlanCoverage(jiraPlans.map(({ plan }) => plan)) : null;
  const bundlesDirectory = join(directory, 'legacy-imports');
  if (packages.length) {
    const stat = await lstat(bundlesDirectory).catch(error => { if (error.code !== 'ENOENT') throw new Error('리허설 원본 보관 디렉터리를 확인해 주세요.'); });
    if (stat && !stat.isDirectory()) throw new Error('리허설 원본 보관 디렉터리를 확인해 주세요.');
  }
  for (const item of packages) {
    signal.throwIfAborted();
    let bytes;
    try {
      bytes = await readBoundedFile(join(bundlesDirectory, `${item.packageId}.bundle`), LEGACY_MAX_RAW_BYTES, undefined, constants.O_NOFOLLOW);
    } catch (error) {
      signal.throwIfAborted();
      bundles.push({ packageId: item.packageId, status: error.code === 'ENOENT' ? 'missing' : 'unreadable' });
      continue;
    }
    const matches = bytes.length === item.size && digest(bytes) === item.sha256;
    if (matches && exactReviews.has(item.packageId)) {
      archivePageIds.set(item.packageId, await readConfluenceArchivePageIds(bytes));
      signal.throwIfAborted();
    }
    if (matches) await jiraCoverage?.addPackage(item, bytes);
    bundles.push({ packageId: item.packageId, status: matches ? 'verified' : 'mismatch' });
  }
  const verified = bundles.every(bundle => bundle.status === 'verified');
  const confluenceReviewCoverage = verified ? combinedConfluenceCoverage(confluenceReviews, archivePageIds) : [];
  const jiraPlanCoverage = verified ? jiraCoverage?.finish() : undefined;
  if (jiraPlanCoverage && !isDeepStrictEqual(jiraPlanCoverage, jiraPlans.map(({ proof }) => proof))) {
    throw new Error('Jira 수집 계획의 묶음과 보관한 ZIP 연결이 리허설 기록과 다릅니다.');
  }
  return { bundles, confluenceReviewCoverage, jiraPlanCoverage };
}

async function verifiedConfluenceCoverage(directory, packages, confluenceReviews) {
  const exactIds = exactCoveragePackageIds(confluenceReviews);
  if (!exactIds.size) return [];
  const { bundles, confluenceReviewCoverage } = await verifyBundles(directory,
    packages.filter(pkg => exactIds.has(pkg.packageId)), confluenceReviews);
  if (bundles.some(bundle => bundle.status !== 'verified')) throw new Error('Confluence 대조에 연결한 ZIP 원본의 무결성을 확인해 주세요.');
  return confluenceReviewCoverage;
}

async function inspectWorkspace(directory, packages, confluenceReviews, jiraPlans) {
  return withPilot(directory, async call => {
    const { bundles, confluenceReviewCoverage, jiraPlanCoverage } = await verifyBundles(directory, packages, confluenceReviews, jiraPlans);
    const evidence = bundles.every(bundle => bundle.status === 'verified')
      ? await collectMigrationEvidence(call, packages, confluenceReviews, confluenceReviewCoverage) : null;
    return { bundles, evidence, ...(jiraPlanCoverage ? { jiraPlanCoverage } : {}) };
  }, pilotReviewOptions(packages, confluenceReviews));
}

async function verify(directory) {
  const { input, root, workspace, embedded, stageSha256, packages, profile, confluenceReviews, jiraPlans } = await loadRun(directory);
  const attempt = await mkdtemp(join(root, 'verification-'));
  const report = { format: reportFormat, version: 1, checkedAt: new Date().toISOString(), status: 'failed',
    source: null, restore: null, comparison: null, ...(profile ? { profile } : {}),
    ...(confluenceReviews.length ? { confluenceReviews: confluenceReviews.map(({ proof }) => proof) } : {}),
    ...(jiraPlans.length ? { jiraPlans: jiraPlans.map(({ proof }) => proof) } : {}) };
  let step = 'source';
  try {
    report.source = await inspectWorkspace(workspace, packages, confluenceReviews, jiraPlans);
    const evidence = report.source.evidence;
    if (evidence && evidence.status !== 'failed') {
      report.status = evidence.status;
      if (evidence.receipts.length) {
        step = 'backup';
        const restored = join(attempt, 'restored');
        await backupAndRestoreRehearsal(workspace, join(attempt, 'backup'), restored, { signal });
        step = 'restore';
        const restoredRun = embedded ? await loadRun(restored) : { packages, confluenceReviews, jiraPlans };
        if (embedded && (!restoredRun.embedded || restoredRun.stageSha256 !== stageSha256)) {
          throw new Error('복원한 리허설 준비 기록이 원본과 일치하지 않습니다.');
        }
        report.restore = await inspectWorkspace(restored, restoredRun.packages, restoredRun.confluenceReviews, restoredRun.jiraPlans);
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
    console.log(`검증 결과 ${relative(input, join(attempt, 'report.json'))} (${report.status})`);
  }
  process.exitCode = report.status === 'verified' ? 0 : report.status === 'review' ? 2 : 1;
}

const usage = [
  'npm run pilot:rehearsal -- profile <manifest.json> <새 분석 보고서.json>',
  'npm run pilot:rehearsal -- stage <manifest.json> <새 리허설 디렉터리> [--profile <분석 보고서.json>] [--jira-plan <수집 계획.json>]… [--confluence-findings <페이지별 검토 파일.json>]…',
  'npm run pilot:rehearsal -- review <리허설 디렉터리 또는 복원된 워크스페이스>',
  'npm run pilot:rehearsal -- verify <리허설 디렉터리 또는 복원된 워크스페이스>',
].join('\n');

function stageOptions(args) {
  if (args.length < 2 || args.length % 2 !== 0 || args.slice(0, 2).some(value => value.startsWith('--'))) throw new Error(usage);
  const options = { profilePath: undefined, findingsPaths: [], jiraPlanPaths: [] };
  for (let index = 2; index < args.length; index += 2) {
    const option = args[index], path = args[index + 1];
    if (!path || path.startsWith('--')) throw new Error(usage);
    if (option === '--profile' && !options.profilePath) options.profilePath = resolve(path);
    else if (option === '--jira-plan' && options.jiraPlanPaths.length < packageLimit) options.jiraPlanPaths.push(resolve(path));
    else if (option === '--confluence-findings' && options.findingsPaths.length < confluenceFindingsLimit) {
      options.findingsPaths.push(resolve(path));
    } else throw new Error(usage);
  }
  return options;
}

process.once('SIGINT', onInterrupt);
process.once('SIGTERM', onTerminate);
try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'profile' && args.length === 2) await profile(resolve(args[0]), resolve(args[1]));
  else if (command === 'stage') {
    const options = stageOptions(args);
    await stage(resolve(args[0]), resolve(args[1]), options);
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
