import assert from 'node:assert/strict';
import test from 'node:test';
import {
  confluenceFindingsProof, CONFLUENCE_FINDING_CODES, CONFLUENCE_FINDINGS_FORMAT, CONFLUENCE_FINDINGS_MAX_BYTES,
  CONFLUENCE_FINDINGS_VERSION, parseConfluenceFindings, validConfluenceFindingsProof,
} from '../../scripts/pilot-migration-confluence-findings.mjs';

const checkedAt = '2026-11-23T06:00:00.000Z';
const reportHash = 'a'.repeat(64);
const zipHash = 'b'.repeat(64);
const packageId = '00000000-0000-4000-8000-000000000002';
const pageId = '99999999999999999999';

function report(overrides = {}) {
  return {
    format: CONFLUENCE_FINDINGS_FORMAT, version: CONFLUENCE_FINDINGS_VERSION, checkedAt, selection: 'explicit-pages',
    status: 'needs-review', archive: { sha256: zipHash, bytes: 13 }, spacePermissions: 'manual-review', unidentifiedPages: 0,
    findings: [{ pageId, codes: ['VERSION_MISMATCH', 'LIVE_RESTRICTED'] }], ...overrides,
  };
}

test('projects a validated findings file into stable counts and no page details', () => {
  const findings = parseConfluenceFindings(report({ unidentifiedPages: 2, findings: [
    { pageId, codes: ['VERSION_MISMATCH', 'LIVE_RESTRICTED'] },
    { pageId: '2', codes: ['ARCHIVE_ONLY_PAGE', 'LIVE_RESTRICTED'] },
  ] }));
  const proof = confluenceFindingsProof(findings, reportHash, packageId);
  assert.deepEqual(proof, {
    packageId, sha256: reportHash, checkedAt, version: 1, selection: 'explicit-pages', status: 'needs-review',
    archive: { sha256: zipHash, bytes: 13 }, spacePermissions: 'manual-review', pageCount: 2, unidentifiedPages: 2,
    reasonCounts: { ARCHIVE_ONLY_PAGE: 1, LIVE_RESTRICTED: 2, VERSION_MISMATCH: 1 },
  });
  assert.deepEqual(Object.keys(proof.reasonCounts), ['ARCHIVE_ONLY_PAGE', 'LIVE_RESTRICTED', 'VERSION_MISMATCH']);
  assert.ok(!JSON.stringify(proof).includes(pageId));
  assert.ok(!Object.hasOwn(proof, 'findings'));
  assert.equal(validConfluenceFindingsProof(proof), true);
});

test('accepts empty matched and needs-review audits with manual space permission review', () => {
  for (const status of ['matched', 'needs-review']) {
    const proof = confluenceFindingsProof(parseConfluenceFindings(report({ status, findings: [] })), reportHash, packageId);
    assert.equal(proof.status, status);
    assert.equal(proof.spacePermissions, 'manual-review');
    assert.equal(proof.pageCount, 0);
    assert.deepEqual(proof.reasonCounts, {});
    assert.equal(validConfluenceFindingsProof(proof), true);
  }
  const unidentified = parseConfluenceFindings(report({ findings: [], unidentifiedPages: 1 }));
  assert.equal(validConfluenceFindingsProof(confluenceFindingsProof(unidentified, reportHash, packageId)), true);
});

test('rejects incompatible metadata, duplicate page or reason, and injected private fields', () => {
  const injected = 'private fixture page content';
  const goodRow = { pageId, codes: ['VERSION_MISMATCH'] };
  for (const invalid of [
    null, [], report({ version: 2 }), report({ checkedAt: '2026-02-30T00:00:00.000Z' }), report({ status: 'observed' }),
    report({ status: 'matched' }), report({ status: 'matched', findings: [], unidentifiedPages: 1 }),
    report({ archive: { sha256: zipHash, bytes: CONFLUENCE_FINDINGS_MAX_BYTES + 1 } }),
    report({ archive: { sha256: zipHash, bytes: 13, file: injected } }), report({ selection: injected }),
    report({ findings: [goodRow, goodRow] }), report({ findings: [{ ...goodRow, codes: [] }] }),
    report({ findings: [{ ...goodRow, codes: ['VERSION_MISMATCH', 'VERSION_MISMATCH'] }] }),
    report({ findings: [{ ...goodRow, codes: ['UNKNOWN'] }] }), report({ findings: [{ ...goodRow, pageId: 1 }] }),
    report({ findings: [{ ...goodRow, pageId: '01' }] }), report({ findings: [{ ...goodRow, pageId: '1'.repeat(21) }] }),
    report({ findings: [{ ...goodRow, text: injected }] }), report({ source: injected }),
  ]) {
    assert.throws(() => parseConfluenceFindings(invalid), error => error instanceof Error &&
      error.message === 'Confluence 페이지별 검토 파일의 형식 또는 건수를 확인해 주세요.' && !error.message.includes(injected));
  }
});

test('rejects a proof with wrong identifiers, incompatible counts, or extra fields', () => {
  const allReasons = confluenceFindingsProof(parseConfluenceFindings(report({
    findings: [{ pageId, codes: [...CONFLUENCE_FINDING_CODES] }],
  })), reportHash, packageId);
  assert.equal(validConfluenceFindingsProof(allReasons), true);
  for (const invalid of [
    { packageId: '../workspace' }, { sha256: 'wrong' }, { archive: { sha256: 'wrong', bytes: 13 } }, { pageCount: 0 },
    { reasonCounts: null }, { reasonCounts: {} }, { reasonCounts: { VERSION_MISMATCH: 2 } },
    { reasonCounts: { VERSION_MISMATCH: 0 } }, { reasonCounts: { VERSION_MISMATCH: 1, UNKNOWN: 1 } },
    { findings: [] }, { spacePermissions: 'passed' }, { unidentifiedPages: Number.MAX_SAFE_INTEGER },
  ]) assert.equal(validConfluenceFindingsProof({ ...allReasons, ...invalid }), false);
});
