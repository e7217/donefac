import { createHash } from 'node:crypto';
import { confirmedConfluenceRestrictions } from './pilot-migration-confluence-findings.mjs';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{64}$/;
const sourceFormats = new Set(['jira-backup-xml', 'jira-search-xml', 'jira-csv', 'jira-json', 'confluence-xml']);
const recordStatuses = ['linked', 'trashed', 'missing', 'archive-only', 'excluded'];
const attachmentStatuses = ['verified', 'missing', 'corrupt', 'unbound', 'excluded', 'unreadable'];
const workspaceSections = ['projects', 'users', 'issues', 'documents', 'workflows', 'issueSchemas', 'dependencies', 'resourceLinks', 'planningItems'];
const sourceRecordPageSize = 100;
const sourceRecordMaxOffset = 1_000_000;

/** @typedef {'matched'|'needs-review'} ConfluenceReviewStatus */
/** @typedef {{proof: {packageId: string, sha256: string, status: ConfluenceReviewStatus,
 * coverage?: {archivePages: number, permissionCheckedPages: number}},
 * findings: {status: ConfluenceReviewStatus, archive: {sha256: string, bytes: number},
 * findings: {pageId: string, codes: string[]}[]}}} ConfluenceReview */

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const product = value => value === 'jira' || value === 'confluence';
const hex = value => typeof value === 'string' && sha.test(value);
const id = value => typeof value === 'string' && uuid.test(value);
const primaryKind = product => product === 'jira' ? 'issue' : 'page';
const sum = values => values.reduce((total, value) => total + value, 0);
const canonicalKeys = (_key, value) => isObject(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value;
const fingerprint = value => createHash('sha256').update(JSON.stringify(value, canonicalKeys)).digest('hex');

function requireEvidence(condition, message) {
  if (!condition) throw new Error(message);
}

function counts(value, statuses) {
  requireEvidence(isObject(value) && statuses.every(status => count(value[status])), '이관 검증 건수 형식이 올바르지 않습니다.');
  return Object.fromEntries(statuses.map(status => [status, value[status]]));
}

function sourceIdentity(sha256, sourceProduct, instanceKey, format) {
  return fingerprint([sha256, sourceProduct, instanceKey, format]);
}

function sourceKey(sha256, sourceProduct, instanceKey) {
  return JSON.stringify([sha256, sourceProduct, instanceKey]);
}

function inputPackages(packages) {
  requireEvidence(Array.isArray(packages) && packages.length > 0, '검증할 이관 원본 패키지가 필요합니다.');
  const byId = new Map();
  for (const entry of packages) {
    const { packageId, product: sourceProduct, format, instanceKey, sha256, size, errors, warnings, counts: analysisCounts } = entry ?? {};
    requireEvidence(id(packageId) && !byId.has(packageId) && product(sourceProduct) && sourceFormats.has(format) &&
      typeof instanceKey === 'string' && instanceKey.length > 0 && hex(sha256) && count(size) && size > 0 && count(errors) && count(warnings),
    '검증할 이관 원본 패키지 정보가 올바르지 않습니다.');
    const kind = primaryKind(sourceProduct);
    requireEvidence(isObject(analysisCounts) && (!Object.hasOwn(analysisCounts, kind) || count(analysisCounts[kind])),
      '이관 준비 기록의 업무·문서 분석 건수가 올바르지 않습니다.');
    byId.set(packageId, { packageId, product: sourceProduct, format, sha256, size, errors, warnings,
      expectedPrimaryRecords: analysisCounts[kind] ?? 0,
      sourceIdentitySha256: sourceIdentity(sha256, sourceProduct, instanceKey, format), receiptIds: [] });
  }
  return byId;
}

function observedCount(value) {
  requireEvidence(isObject(value) && (value.expected === null || count(value.expected)) && count(value.observed),
    '원본 검증 기준과 결과 건수가 올바르지 않습니다.');
  return { expected: value.expected, observed: value.observed };
}

function archiveIntegrity(raw) {
  requireEvidence(isObject(raw) && ['verified', 'mismatch', 'counts-only', 'unavailable'].includes(raw.status) &&
    count(raw.unmatchedRecords) && count(raw.columnMismatches) && Array.isArray(raw.packages), '원본 보관 검증 결과 형식이 올바르지 않습니다.');
  const packages = raw.packages.map(entry => {
    requireEvidence(id(entry?.stagingId) && ['verified', 'mismatch', 'unavailable'].includes(entry.status) &&
      isObject(entry.recordsSha256) && (entry.recordsSha256.expected === null || hex(entry.recordsSha256.expected)) && hex(entry.recordsSha256.observed),
    '패키지별 원본 보관 검증 결과 형식이 올바르지 않습니다.');
    return { packageId: entry.stagingId, status: entry.status, records: observedCount(entry.records),
      boundAttachments: observedCount(entry.boundAttachments),
      recordsSha256: { expected: entry.recordsSha256.expected, observed: entry.recordsSha256.observed } };
  }).sort((a, b) => a.packageId.localeCompare(b.packageId));
  return { status: raw.status, records: observedCount(raw.records), boundAttachments: observedCount(raw.boundAttachments),
    unmatchedRecords: raw.unmatchedRecords, columnMismatches: raw.columnMismatches, packages };
}

function attachmentEvidence(raw, receiptKeys, expectedCounts) {
  requireEvidence(Array.isArray(raw), '첨부파일 검증 결과 목록이 올바르지 않습니다.');
  const observed = Object.fromEntries(attachmentStatuses.map(status => [status, 0]));
  const records = new Set();
  const observations = raw.map(entry => {
    requireEvidence(id(entry?.sourceRecordId) && !records.has(entry.sourceRecordId) && recordStatuses.includes(entry.recordStatus) &&
      attachmentStatuses.includes(entry.status) && (entry.status !== 'verified' || id(entry.fileId) && count(entry.size) && entry.size > 0 && hex(entry.sha256)) &&
      receiptKeys.has(sourceKey(entry.packageSha256, entry.product, entry.sourceInstance)), '첨부파일의 검증 결과 또는 원본 연결이 올바르지 않습니다.');
    records.add(entry.sourceRecordId);
    observed[entry.status]++;
    return [entry.sourceRecordId, id(entry.fileId) ? entry.fileId : null, entry.recordStatus, entry.status,
      count(entry.size) ? entry.size : null, hex(entry.sha256) ? entry.sha256 : null, entry.packageSha256];
  });
  requireEvidence(attachmentStatuses.every(status => observed[status] === expectedCounts[status]), '첨부파일 검증 행과 집계 건수가 다릅니다.');
  observations.sort((a, b) => a[0].localeCompare(b[0]));
  return fingerprint(observations);
}

function targetContentEvidence(raw) {
  requireEvidence(isObject(raw) && raw.version === 1, '이관 대상 내용 검증 형식 또는 버전이 올바르지 않습니다.');
  function section(name) {
    const value = raw[name];
    requireEvidence(isObject(value) && count(value.count) && hex(value.sha256), `이관 대상 내용 검증 항목(${name})의 건수 또는 해시가 올바르지 않습니다.`);
    return { count: value.count, sha256: value.sha256 };
  }
  return { version: 1, comments: section('comments'), revisions: section('revisions'),
    worklogs: section('worklogs'), issueRelations: section('issueRelations') };
}

function primaryRecordsEvidence(raw, receiptPackages, matches, integrity, recordCounts) {
  const message = '영수증의 패키지별 업무·문서 연결 검증 결과가 올바르지 않습니다.';
  requireEvidence(Array.isArray(raw) && raw.length === receiptPackages.length, message);
  const receiptKinds = new Map(receiptPackages.map(pkg => [pkg.stagingId, primaryKind(pkg.source.product)]));
  const archiveCounts = new Map(integrity.packages.map(pkg => [pkg.packageId, pkg.records.observed]));
  const totals = Object.fromEntries(recordStatuses.map(status => [status, 0]));
  const seen = new Set();
  const proof = raw.map(entry => {
    const { packageId, kind, invalidTargets, dispositionSha256 } = entry ?? {};
    requireEvidence(receiptKinds.has(packageId) && !seen.has(packageId) && kind === receiptKinds.get(packageId) &&
      count(invalidTargets) && hex(dispositionSha256), message);
    seen.add(packageId);
    const statusCounts = counts(entry.counts, recordStatuses);
    const observed = sum(Object.values(statusCounts));
    requireEvidence(count(observed) && observed <= archiveCounts.get(packageId) && invalidTargets <= observed, message);
    for (const status of recordStatuses) totals[status] += statusCounts[status];
    return { packageId, kind, counts: statusCounts, invalidTargets, dispositionSha256,
      records: { expected: matches.get(packageId)?.expectedPrimaryRecords ?? null, observed } };
  });
  requireEvidence(recordStatuses.every(status => totals[status] <= recordCounts[status]), message);
  return proof.sort((left, right) => left.packageId.localeCompare(right.packageId));
}

function jiraStatusHistoryEvidence(raw, hasJira) {
  const message = 'Jira 상태 이력의 검증 건수 또는 해시가 올바르지 않습니다.';
  if (!hasJira) {
    requireEvidence(raw === null, message);
    return null;
  }
  requireEvidence(isObject(raw) && isObject(raw.projected), message);
  const { sourceChanges, projected, duplicate, excluded, restricted, unavailable, unresolvedTime, unresolvedAuthor } = raw;
  const classified = [projected.count, duplicate, excluded, restricted, unavailable];
  requireEvidence([sourceChanges, ...classified, unresolvedTime, unresolvedAuthor].every(count) && hex(projected.sha256) &&
    sum(classified) === sourceChanges && unresolvedTime <= projected.count && unresolvedAuthor <= projected.count, message);
  return { sourceChanges, projected: { count: projected.count, sha256: projected.sha256 }, duplicate, excluded, restricted,
    unavailable, unresolvedTime, unresolvedAuthor };
}

function noticeCounts(notices) {
  const counts = new Map();
  for (const notice of notices ?? []) {
    if (!['error', 'warning', 'info'].includes(notice?.severity)) continue;
    const code = typeof notice.code === 'string' && /^[A-Z][A-Z\d_]{0,99}$/.test(notice.code) ? notice.code : 'UNRECOGNIZED_NOTICE_CODE';
    const key = `${notice.severity}:${code}`;
    if (!counts.has(key)) counts.set(key, { severity: notice.severity, code, count: 0 });
    counts.get(key).count++;
  }
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
}

async function auditReceipt(call, receipt, matches, receiptKeys) {
  const noticesAvailable = Array.isArray(receipt.notices);
  requireEvidence(noticesAvailable || receipt.notices === undefined || receipt.notices === null, '이관 영수증의 검토 진단 형식이 올바르지 않습니다.');
  const raw = await call(`/source-imports/${receipt.id}/reconciliation/audit?expectedVersion=${receipt.version}`, { timeoutMs: 120_000 });
  requireEvidence(raw?.importId === receipt.id && raw.receiptVersion === receipt.version, '검증 결과와 이관 영수증의 버전이 다릅니다.');
  const integrity = archiveIntegrity(raw.integrity);
  const recordCounts = counts(raw.recordCounts, recordStatuses);
  const attachmentCounts = counts(raw.attachmentCounts, attachmentStatuses);
  requireEvidence(integrity.records.observed === sum(Object.values(recordCounts)), '이관 원본의 검증 건수와 대조 건수가 다릅니다.');
  const primaryRecords = primaryRecordsEvidence(raw.primaryRecords, receipt.packages, matches, integrity, recordCounts);
  const attachmentsSha256 = attachmentEvidence(raw.attachments, receiptKeys, attachmentCounts);
  const targetContent = targetContentEvidence(raw.targetContent);
  const jiraStatusHistory = jiraStatusHistoryEvidence(raw.jiraStatusHistory, receipt.packages.some(pkg => pkg.source.product === 'jira'));
  return { id: receipt.id, version: receipt.version, packageIds: [...matches.keys()].sort(),
    projectCount: receipt.projectIds.length, integrity, recordCounts, primaryRecords, attachmentCounts, attachmentsSha256, targetContent, jiraStatusHistory,
    configurationSha256: fingerprint([receipt.projectIds.slice().sort(), receipt.configuration]),
    noticesAvailable, notices: noticeCounts(receipt.notices) };
}

function validateConfluenceReviews(reviews, packages) {
  const digests = new Set();
  for (const { proof, findings } of reviews) {
    const pkg = packages.get(proof?.packageId);
    requireEvidence(pkg?.product === 'confluence' && pkg.format === 'confluence-xml' && hex(proof.sha256) &&
      !digests.has(proof.sha256) && ['matched', 'needs-review'].includes(proof.status) &&
      findings?.status === proof.status && findings.archive?.sha256 === pkg.sha256 && findings.archive.bytes === pkg.size &&
      Array.isArray(findings.findings),
    'Confluence 페이지별 검토와 이관 원본의 연결을 확인할 수 없습니다.');
    digests.add(proof.sha256);
  }
}

async function readReviewedPageDispositions(call, receipt, reviewedSources, restrictedSources, recordCount) {
  const invalid = 'Confluence 페이지별 검토의 영수증 원본 목록을 확인할 수 없습니다.';
  const configuredExclusions = receipt.configuration?.excludedRecords ?? [];
  requireEvidence(Array.isArray(configuredExclusions), invalid);
  const excluded = new Set(configuredExclusions);
  const restrictedTargets = new Set();
  let total;
  for (let offset = 0; total === undefined || offset < total; offset += sourceRecordPageSize) {
    requireEvidence(offset <= sourceRecordMaxOffset, invalid);
    const page = await call(`/source-imports/${receipt.id}/records?kind=page&offset=${offset}&limit=${sourceRecordPageSize}`);
    requireEvidence(page && count(page.total) && (recordCount === undefined || page.total <= recordCount) &&
      (total === undefined || page.total === total) &&
      page.offset === offset && page.limit === sourceRecordPageSize && Array.isArray(page.records) &&
      page.records.length === Math.min(sourceRecordPageSize, page.total - offset), invalid);
    total = page.total;
    for (const row of page.records) {
      requireEvidence(row?.sourceImportId === receipt.id && row.record?.kind === 'page' &&
        typeof row.record.sourceId === 'string' && row.record.id === `page:${row.record.sourceId}` &&
        hex(row.packageSha256) && product(row.source?.product) && typeof row.source.instanceKey === 'string', invalid);
      const key = sourceKey(row.packageSha256, row.source.product, row.source.instanceKey);
      const documentBound = row.targetType === 'document' && typeof row.targetId === 'string' && row.targetId.length > 0;
      if (documentBound && row.source.format === 'confluence-xml' && restrictedSources.get(key)?.has(row.record.sourceId)) {
        restrictedTargets.add(row.targetId);
      }
      const source = reviewedSources.get(key);
      if (!source?.pages.has(row.record.sourceId)) continue;
      requireEvidence(row.source.format === 'confluence-xml' && source.pages.get(row.record.sourceId) === null, invalid);
      source.pages.set(row.record.sourceId, {
        excluded: row.excluded === true || excluded.has(`${source.packageId}/${row.record.id}`),
        documentBound,
      });
    }
  }
  return restrictedTargets.size;
}

function confluenceDispositions() {
  return { excluded: 0, documentBound: 0, archiveOnly: 0, absent: 0 };
}

/** @param {ConfluenceReview[]} reviews */
async function auditConfluenceReviews(call, receipt, reviews, restrictedPages, recordCount) {
  const packages = new Map(receipt.packages.map(pkg => [pkg.stagingId, pkg]));
  const restrictedSources = new Map();
  for (const { sha256, source } of packages.values()) {
    if (source.product !== 'confluence' || source.format !== 'confluence-xml') continue;
    const pages = restrictedPages.get(source.instanceKey);
    if (pages) restrictedSources.set(sourceKey(sha256, source.product, source.instanceKey), pages);
  }
  const reviewedSources = new Map();
  for (const { proof, findings } of reviews) {
    if (!findings.findings.length) continue;
    const { sha256, source } = packages.get(proof.packageId);
    const key = sourceKey(sha256, source.product, source.instanceKey);
    if (!reviewedSources.has(key)) reviewedSources.set(key, { packageId: proof.packageId, pages: new Map() });
    for (const { pageId } of findings.findings) reviewedSources.get(key).pages.set(pageId, null);
  }
  const liveRestrictedConfluenceDocumentCount = reviewedSources.size || restrictedSources.size
    ? await readReviewedPageDispositions(call, receipt, reviewedSources, restrictedSources, recordCount) : 0;
  const confluenceReviews = reviews.map(({ proof, findings }) => {
    const { packageId, sha256 } = proof;
    const pkg = packages.get(packageId);
    const counts = confluenceDispositions();
    const liveRestrictedCounts = confluenceDispositions();
    const source = reviewedSources.get(sourceKey(pkg.sha256, pkg.source.product, pkg.source.instanceKey));
    const rows = findings.findings.map(({ pageId, codes }) => {
      const row = source.pages.get(pageId);
      const disposition = !row ? 'absent' : row.excluded ? 'excluded' : row.documentBound ? 'documentBound' : 'archiveOnly';
      counts[disposition]++;
      const sortedCodes = [...codes].sort();
      if (!codes.includes('LIVE_RESTRICTED')) return [pageId, sortedCodes, disposition];
      // An actual document binding is evidence of application even when the receipt also marks an exclusion.
      const restrictedDisposition = row?.documentBound ? 'documentBound' : disposition;
      liveRestrictedCounts[restrictedDisposition]++;
      return [pageId, sortedCodes, disposition, restrictedDisposition];
    }).sort(([first], [second]) => first.localeCompare(second));
    return { packageId, sha256, counts, liveRestrictedCounts, dispositionsSha256: fingerprint([sha256, rows]) };
  }).sort((a, b) => a.packageId.localeCompare(b.packageId) || a.sha256.localeCompare(b.sha256));
  return { confluenceReviews, liveRestrictedConfluenceDocumentCount };
}

function workspaceEvidence(workspace) {
  const digest = createHash('sha256');
  /** @type {Record<string, number>} */
  const counts = {};
  for (const section of workspaceSections) {
    const rows = workspace?.[section];
    requireEvidence(Array.isArray(rows) && rows.every(row => isObject(row) && typeof row.id === 'string'), '워크스페이스의 복원 검증 목록이 올바르지 않습니다.');
    counts[section] = rows.length;
    digest.update(JSON.stringify([section, rows.length])).update('\n');
    for (const row of rows.slice().sort((a, b) => a.id.localeCompare(b.id))) {
      digest.update(JSON.stringify(row, canonicalKeys)).update('\n');
    }
  }
  return { counts, sha256: digest.digest('hex') };
}

function failedAudit({ integrity, recordCounts, attachmentCounts, notices }) {
  return integrity.status !== 'verified' || integrity.unmatchedRecords > 0 || integrity.columnMismatches > 0 ||
    integrity.records.expected !== integrity.records.observed || integrity.boundAttachments.expected !== integrity.boundAttachments.observed ||
    integrity.packages.some(pkg => pkg.status !== 'verified' || pkg.records.expected !== pkg.records.observed ||
      pkg.boundAttachments.expected !== pkg.boundAttachments.observed || pkg.recordsSha256.expected !== pkg.recordsSha256.observed) ||
    recordCounts.missing > 0 || attachmentCounts.missing > 0 || attachmentCounts.corrupt > 0 || attachmentCounts.unreadable > 0 ||
    notices.some(notice => notice.severity === 'error');
}

/** Read whole source audits and return only counts, generated IDs, and fingerprints.
 * @param {(path: string, options?: {timeoutMs: number}) => Promise<unknown>} call
 * @param {{packageId: string, product: string, format: string, instanceKey: string, sha256: string, size: number, errors: number, warnings: number, counts: Record<string, number>}[]} packages
 * @param {ConfluenceReview[]} [confluenceReviews]
 */
export async function collectMigrationEvidence(call, packages, confluenceReviews = []) {
  const expected = inputPackages(packages);
  validateConfluenceReviews(confluenceReviews, expected);
  const restrictedPages = confirmedConfluenceRestrictions(confluenceReviews, packages);
  const imports = await call('/source-imports');
  requireEvidence(Array.isArray(imports), '워크스페이스 이관 영수증 목록을 확인할 수 없습니다.');
  const withoutFullCoverage = new Set(packages
    .filter(pkg => pkg.product === 'confluence' && pkg.format === 'confluence-xml')
    .map(pkg => pkg.packageId));
  for (const { proof: { packageId, coverage } } of confluenceReviews) {
    if (coverage && coverage.archivePages === coverage.permissionCheckedPages) withoutFullCoverage.delete(packageId);
  }
  const checks = { pendingPackages: 0, unexpectedReceipts: 0, unmatchedPackages: 0, sourceIdentityMismatches: 0,
    receiptsWithWarnings: 0, receiptsWithoutNotices: 0, receiptsWithJiraHistoryReview: 0,
    receiptsWithLiveRestrictedConfluenceDocuments: 0, receiptsWithPrimaryRecordCountMismatches: 0,
    receiptsWithInvalidPrimaryTargets: 0, receiptsWithArchiveOnlyPrimaryRecords: 0,
    confluencePackagesWithoutFullPageCoverage: withoutFullCoverage.size };
  const seenReceipts = new Set();
  const receipts = [];
  for (const receipt of imports) {
    requireEvidence(id(receipt?.id) && !seenReceipts.has(receipt.id) && count(receipt.version) && receipt.version > 0 &&
      Array.isArray(receipt.packages) && Array.isArray(receipt.projectIds), '이관 영수증 형식이 올바르지 않습니다.');
    seenReceipts.add(receipt.id);
    const matches = new Map();
    const packageIds = new Set();
    const receiptKeys = new Set();
    for (const pkg of receipt.packages) {
      requireEvidence(id(pkg?.stagingId) && !packageIds.has(pkg.stagingId) && hex(pkg.sha256) && product(pkg.source?.product) &&
        typeof pkg.source.instanceKey === 'string' && sourceFormats.has(pkg.source.format), '영수증의 원본 패키지 정보가 올바르지 않습니다.');
      packageIds.add(pkg.stagingId);
      receiptKeys.add(sourceKey(pkg.sha256, pkg.source.product, pkg.source.instanceKey));
      const entry = expected.get(pkg.stagingId);
      if (!entry) continue;
      if (entry.sourceIdentitySha256 !== sourceIdentity(pkg.sha256, pkg.source.product, pkg.source.instanceKey, pkg.source.format)) {
        checks.sourceIdentityMismatches++;
        continue;
      }
      entry.receiptIds.push(receipt.id);
      matches.set(pkg.stagingId, entry);
    }
    let evidence;
    if (matches.size) {
      checks.unmatchedPackages += packageIds.size - matches.size;
      evidence = await auditReceipt(call, receipt, matches, receiptKeys);
      requireEvidence(evidence.integrity.packages.length === packageIds.size &&
        new Set(evidence.integrity.packages.map(pkg => pkg.packageId)).size === packageIds.size &&
        evidence.integrity.packages.every(pkg => packageIds.has(pkg.packageId)), '원본 검증 결과의 패키지와 이관 영수증이 일치하지 않습니다.');
    } else {
      checks.unexpectedReceipts++;
    }
    const matchedReviews = confluenceReviews.filter(({ proof }) => matches.has(proof.packageId));
    const reviewed = await auditConfluenceReviews(call, receipt, matchedReviews, restrictedPages, evidence?.integrity.records.observed);
    if (reviewed.liveRestrictedConfluenceDocumentCount) checks.receiptsWithLiveRestrictedConfluenceDocuments++;
    if (evidence) receipts.push({ ...evidence, liveRestrictedConfluenceDocumentCount: reviewed.liveRestrictedConfluenceDocumentCount,
      ...(reviewed.confluenceReviews.length ? { confluenceReviews: reviewed.confluenceReviews } : {}) });
  }
  const staged = [...expected.values()].sort((a, b) => a.packageId.localeCompare(b.packageId));
  for (const pkg of staged) pkg.receiptIds.sort();
  checks.pendingPackages = staged.filter(pkg => !pkg.receiptIds.length).length;
  checks.receiptsWithWarnings = receipts.filter(receipt => receipt.notices.some(notice => notice.severity === 'warning')).length;
  checks.receiptsWithoutNotices = receipts.filter(receipt => !receipt.noticesAvailable).length;
  checks.receiptsWithJiraHistoryReview = receipts.filter(({ jiraStatusHistory }) => jiraStatusHistory &&
    (jiraStatusHistory.unavailable > 0 || jiraStatusHistory.restricted > 0 || jiraStatusHistory.unresolvedTime > 0 || jiraStatusHistory.unresolvedAuthor > 0)).length;
  for (const { primaryRecords } of receipts) {
    if (primaryRecords.some(({ records }) => records.expected !== null && records.expected !== records.observed)) checks.receiptsWithPrimaryRecordCountMismatches++;
    if (primaryRecords.some(record => record.invalidTargets > 0)) checks.receiptsWithInvalidPrimaryTargets++;
    if (primaryRecords.some(record => record.counts['archive-only'] > 0)) checks.receiptsWithArchiveOnlyPrimaryRecords++;
  }
  receipts.sort((a, b) => a.id.localeCompare(b.id));
  const failed = checks.sourceIdentityMismatches > 0 || checks.receiptsWithLiveRestrictedConfluenceDocuments > 0 ||
    checks.receiptsWithPrimaryRecordCountMismatches > 0 || checks.receiptsWithInvalidPrimaryTargets > 0 || receipts.some(failedAudit);
  const review = confluenceReviews.some(({ proof }) => proof.status === 'needs-review') ||
    Object.values(checks).some(Boolean) || staged.some(pkg => pkg.errors > 0) || receipts.some(receipt =>
    receipt.recordCounts.trashed > 0 || receipt.recordCounts.excluded > 0 || receipt.attachmentCounts.unbound > 0);
  const workspace = workspaceEvidence(await call('/workspace', { timeoutMs: 120_000 }));
  return { status: failed ? 'failed' : review ? 'review' : 'verified', checks, packages: staged, receipts, workspace };
}

/** Physical restore may return a different receipt revision; the evidence itself must agree. */
export function compareMigrationEvidence(before, after) {
  const comparable = evidence => {
    const snapshot = { ...evidence };
    delete snapshot.version;
    return fingerprint(snapshot);
  };
  const first = new Map(before.receipts.map(evidence => [evidence.id, comparable(evidence)]));
  const second = new Map(after.receipts.map(evidence => [evidence.id, comparable(evidence)]));
  const changedReceiptIds = [...new Set([...first.keys(), ...second.keys()])].filter(id => first.get(id) !== second.get(id)).sort();
  const packagesMatch = JSON.stringify(before.packages) === JSON.stringify(after.packages);
  const workspaceMatches = before.workspace.sha256 === after.workspace.sha256;
  const matches = changedReceiptIds.length === 0 && packagesMatch && workspaceMatches &&
    JSON.stringify(before.checks) === JSON.stringify(after.checks) && before.status === after.status;
  return { status: matches ? before.status : 'failed', matches, changedReceiptIds, workspaceMatches, packagesMatch };
}
