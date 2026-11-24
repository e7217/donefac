export const CONFLUENCE_FINDINGS_FORMAT = 'teamspace-confluence-audit-findings';
export const CONFLUENCE_FINDINGS_VERSION = 2;
export const CONFLUENCE_FINDINGS_MAX_BYTES = 64 * 1024 * 1024;

export const CONFLUENCE_FINDING_CODES = Object.freeze([
  'ARCHIVE_ONLY_PAGE',
  'ARCHIVE_RESTRICTED',
  'ATTACHMENT_EVIDENCE_PROBLEM',
  'HIERARCHY_MISMATCH',
  'LIVE_PAGE_UNAVAILABLE',
  'LIVE_RESTRICTED',
  'LIVE_RESTRICTION_UNKNOWN',
  'MISSING_ARCHIVE_BODY',
  'MISSING_FROM_ARCHIVE',
  'RESTRICTION_MISMATCH',
  'VERSION_MISMATCH',
]);

const statuses = new Set(['matched', 'needs-review']);
const selections = new Set(['explicit-pages', 'visible-space']);
const knownCodes = new Set(CONFLUENCE_FINDING_CODES);
const hashPattern = /^[a-f0-9]{64}$/u;
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const pageIdPattern = /^[1-9]\d{0,19}$/u;
const timePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const maxArchiveBytes = 64 * 1024 * 1024;
const maxArchivePages = 100_000;
const maxLivePages = 500;
const maxPageCount = maxArchivePages + maxLivePages;
const invalidFindings = 'Confluence 페이지별 검토 파일의 형식 또는 건수를 확인해 주세요.';
const commonKeys = ['version', 'checkedAt', 'selection', 'status', 'archive', 'spacePermissions', 'unidentifiedPages'];
const findingsKeys = ['format', 'findings', ...commonKeys];
const proofKeys = ['packageId', 'sha256', 'pageCount', 'reasonCounts', ...commonKeys];
const coverageKeys = ['archivePages', 'matchedPages', 'permissionCheckedPages', 'outsideSelectionPages', 'otherSpacePages', 'unassignedPages'];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasKeys(value, keys) {
  return isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function isHash(value) {
  return typeof value === 'string' && hashPattern.test(value);
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function hasVersionedKeys(value, keys) {
  if (value?.version === 1) return hasKeys(value, keys);
  return value?.version === CONFLUENCE_FINDINGS_VERSION && hasKeys(value, [...keys, 'coverage']);
}

function validCoverage(value) {
  const { coverage, selection, status } = value;
  if (!hasKeys(coverage, coverageKeys) || !coverageKeys.every(key => isCount(coverage[key]))) return false;
  const { archivePages, matchedPages, permissionCheckedPages, outsideSelectionPages, otherSpacePages, unassignedPages } = coverage;
  const inScope = archivePages - outsideSelectionPages - otherSpacePages - unassignedPages;
  return archivePages <= maxArchivePages && matchedPages <= maxLivePages && matchedPages <= inScope &&
    permissionCheckedPages <= matchedPages && (selection === 'explicit-pages' || outsideSelectionPages === 0) &&
    (status === 'needs-review' || (matchedPages > 0 && inScope === matchedPages && permissionCheckedPages === matchedPages && unassignedPages === 0));
}

function validMetadata(value, pageCount) {
  const { version, checkedAt, selection, status, archive, spacePermissions, unidentifiedPages } = value;
  return typeof checkedAt === 'string' && timePattern.test(checkedAt) &&
    Number.isFinite(Date.parse(checkedAt)) && new Date(checkedAt).toISOString() === checkedAt && selections.has(selection) &&
    statuses.has(status) && hasKeys(archive, ['sha256', 'bytes']) && isHash(archive.sha256) &&
    isCount(archive.bytes) && archive.bytes > 0 && archive.bytes <= maxArchiveBytes && spacePermissions === 'manual-review' &&
    isCount(pageCount) && isCount(unidentifiedPages) && pageCount + unidentifiedPages <= maxPageCount &&
    (status === 'needs-review' || (pageCount === 0 && unidentifiedPages === 0)) && (version === 1 || validCoverage(value));
}

export function parseConfluenceFindings(raw) {
  if (!hasVersionedKeys(raw, findingsKeys) || raw.format !== CONFLUENCE_FINDINGS_FORMAT || !Array.isArray(raw.findings) ||
      !validMetadata(raw, raw.findings.length)) throw new Error(invalidFindings);

  const pageIds = new Set();
  for (const row of raw.findings) {
    if (!hasKeys(row, ['pageId', 'codes']) || typeof row.pageId !== 'string' || !pageIdPattern.test(row.pageId) ||
        pageIds.has(row.pageId) || !Array.isArray(row.codes) || !row.codes.length || row.codes.length > knownCodes.size ||
        new Set(row.codes).size !== row.codes.length || Array.from(row.codes).some(code => !knownCodes.has(code))) {
      throw new Error(invalidFindings);
    }
    pageIds.add(row.pageId);
  }
  return raw;
}

export function confirmedConfluenceRestrictions(reviews, packages) {
  const instances = new Map(packages.map(pkg => [pkg.packageId, pkg.instanceKey]));
  const restrictedPages = new Map();
  for (const { proof, findings } of reviews) {
    const instance = instances.get(proof.packageId);
    for (const { pageId, codes } of findings.findings) {
      if (!codes.includes('LIVE_RESTRICTED')) continue;
      if (!restrictedPages.has(instance)) restrictedPages.set(instance, new Set());
      restrictedPages.get(instance).add(pageId);
    }
  }
  return restrictedPages;
}

export function confluenceFindingsProof(findings, sha256, packageId) {
  const { checkedAt, version, selection, status, archive, spacePermissions, unidentifiedPages, coverage } = findings;
  const counts = new Map();
  for (const row of findings.findings) {
    for (const code of row.codes) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const reasonCounts = Object.fromEntries(CONFLUENCE_FINDING_CODES.filter(code => counts.has(code)).map(code => [code, counts.get(code)]));
  return {
    packageId, sha256, checkedAt, version, selection, status, archive: { sha256: archive.sha256, bytes: archive.bytes },
    spacePermissions, pageCount: findings.findings.length, unidentifiedPages, reasonCounts,
    ...(version === CONFLUENCE_FINDINGS_VERSION ? { coverage: { ...coverage } } : {}),
  };
}

export function validConfluenceFindingsProof(proof) {
  if (!hasVersionedKeys(proof, proofKeys) || typeof proof.packageId !== 'string' || !uuidPattern.test(proof.packageId) ||
      !isHash(proof.sha256) || !validMetadata(proof, proof.pageCount) || !isObject(proof.reasonCounts)) return false;

  const reasons = Object.entries(proof.reasonCounts);
  return reasons.every(([code, count]) => knownCodes.has(code) && isCount(count) && count > 0 && count <= proof.pageCount) &&
    reasons.reduce((total, [, count]) => total + count, 0) >= proof.pageCount;
}
