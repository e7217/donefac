import assert from 'node:assert/strict';
import test from 'node:test';
import {
  combinedConfluenceCoverage, confluenceFindingsProof, CONFLUENCE_FINDINGS_FORMAT, CONFLUENCE_FINDINGS_VERSION,
  parseConfluenceFindings, validConfluenceFindingsProof,
} from '../../scripts/pilot-migration-confluence-findings.mjs';
import { collectMigrationEvidence, compareMigrationEvidence } from '../../scripts/pilot-migration-evidence.mjs';

const firstPackageId = '00000000-0000-4000-8000-000000000002';
const secondPackageId = '00000000-0000-4000-8000-000000000003';
const archiveSha256 = 'a'.repeat(64);

function report(permissionCheckedPageIds: string[], archivePages: number) {
  const checked = permissionCheckedPageIds.length;
  return {
    format: CONFLUENCE_FINDINGS_FORMAT, version: CONFLUENCE_FINDINGS_VERSION, checkedAt: '2026-11-24T06:00:00.000Z',
    selection: 'explicit-pages' as const, status: 'matched' as const, archive: { sha256: archiveSha256, bytes: 13 },
    spacePermissions: 'manual-review', unidentifiedPages: 0, findings: [], permissionCheckedPageIds,
    coverage: { archivePages, matchedPages: checked, permissionCheckedPages: checked,
      outsideSelectionPages: archivePages - checked, otherSpacePages: 0, unassignedPages: 0 },
  };
}

function review(ids: string[], archivePages: number, digestCharacter: string, packageId = firstPackageId) {
  const findings = parseConfluenceFindings(report(ids, archivePages));
  return { findings, proof: confluenceFindingsProof(findings, digestCharacter.repeat(64), packageId) };
}

test('v3 binds checked IDs to the sidecar count and keeps IDs out of its stage proof', () => {
  const checked = ['99999999999999999999', '1'];
  const raw = report(checked, 3);
  assert.deepEqual(parseConfluenceFindings(raw).permissionCheckedPageIds, checked);
  const proof = confluenceFindingsProof(raw, 'b'.repeat(64), firstPackageId);
  assert.equal(proof.version, 3);
  assert.equal(proof.coverage?.permissionCheckedPages, 2);
  assert.ok(validConfluenceFindingsProof(proof));
  assert.ok(!validConfluenceFindingsProof({ ...proof, permissionCheckedPageIds: checked }));
  assert.doesNotMatch(JSON.stringify(proof), /99999999999999999999|permissionCheckedPageIds/u);
  for (const permissionCheckedPageIds of [undefined, [], ['1', '1'], ['1', '02'], ['1', 2], ['1', '9'.repeat(21)]]) {
    assert.throws(() => parseConfluenceFindings({ ...raw, permissionCheckedPageIds }), /형식 또는 건수/u);
  }
  for (const code of ['ARCHIVE_ONLY_PAGE', 'LIVE_PAGE_UNAVAILABLE', 'LIVE_RESTRICTION_UNKNOWN', 'MISSING_FROM_ARCHIVE']) {
    assert.throws(() => parseConfluenceFindings({ ...raw, status: 'needs-review', findings: [{ pageId: '1', codes: [code] }] }), /형식 또는 건수/u);
  }
  const restricted = parseConfluenceFindings({ ...raw, status: 'needs-review', findings: [{ pageId: '1', codes: ['LIVE_RESTRICTED'] }] });
  assert.equal(restricted.permissionCheckedPageIds.length, 2);
});

test('combined coverage deduplicates reviewed pages within their exact ZIP and rejects unexpected pages', () => {
  const largeArchive = Array.from({ length: 501 }, (_, index) => String(index + 1));
  const archive = new Map([[firstPackageId, new Set(largeArchive)], [secondPackageId, new Set(['1', '2'])]]);
  const firstBatch = review(largeArchive.slice(0, 500), 501, 'b');
  const overlaps = review(['2', '500'], 501, 'c');
  const completes = review(['500', '501'], 501, 'd');
  const anotherPackage = review(['1'], 2, 'e', secondPackageId);
  assert.deepEqual(combinedConfluenceCoverage([anotherPackage, overlaps, firstBatch], archive), [
    { packageId: firstPackageId, archivePages: 501, permissionCheckedPages: 500 },
    { packageId: secondPackageId, archivePages: 2, permissionCheckedPages: 1 },
  ]);
  assert.deepEqual(combinedConfluenceCoverage([completes, firstBatch], archive), [
    { packageId: firstPackageId, archivePages: 501, permissionCheckedPages: 501 },
  ]);
  for (const invalid of [review(['502'], 501, 'e'), review(['1'], 500, 'e')]) {
    assert.throws(() => combinedConfluenceCoverage([firstBatch, invalid], archive), /ZIP의 현재 페이지 목록/u);
  }
  assert.throws(() => combinedConfluenceCoverage([firstBatch], new Map()), /ZIP의 현재 페이지 목록/u);
});

test('evidence clears the missing coverage check only from verified v3 counts or a complete legacy v2 review', async () => {
  const packages = [{ packageId: firstPackageId, product: 'confluence', format: 'confluence-xml', instanceKey: 'wiki',
    sha256: archiveSha256, size: 13, errors: 0, warnings: 0, counts: { page: 2 } }];
  const workspace = Object.fromEntries(['projects', 'users', 'issues', 'documents', 'workflows', 'issueSchemas',
    'dependencies', 'resourceLinks', 'planningItems', 'documentOrders'].map(section => [section, []]));
  async function call(path: string) {
    if (path === '/source-imports') return [];
    assert.equal(path, '/workspace');
    return workspace;
  }
  const first = review(['1'], 2, 'b'), second = review(['2'], 2, 'c');
  const archive = new Map([[firstPackageId, new Set(['1', '2'])]]);
  const missing = await collectMigrationEvidence(call, packages, [review(['1', '2'], 2, 'b')]);
  assert.equal(missing.checks.confluencePackagesWithoutFullPageCoverage, 1);
  const covered = await collectMigrationEvidence(call, packages, [first, second], combinedConfluenceCoverage([first, second], archive));
  assert.equal(covered.checks.confluencePackagesWithoutFullPageCoverage, 0);
  assert.deepEqual(covered.confluenceReviewCoverage, [{ packageId: firstPackageId, archivePages: 2, permissionCheckedPages: 2 }]);
  const partial = await collectMigrationEvidence(call, packages, [first], combinedConfluenceCoverage([first], archive));
  assert.equal(compareMigrationEvidence(missing, partial).matches, false);
  assert.doesNotMatch(JSON.stringify(covered), /permissionCheckedPageIds/u);
  const { permissionCheckedPageIds: _, ...older } = report(['1', '2'], 2);
  assert.equal(_.length, 2);
  const findings = parseConfluenceFindings({ ...older, version: 2 });
  const proof = confluenceFindingsProof(findings, 'b'.repeat(64), firstPackageId);
  const legacy = await collectMigrationEvidence(call, packages, [{ proof, findings }]);
  assert.ok(validConfluenceFindingsProof(proof));
  assert.equal(legacy.checks.confluencePackagesWithoutFullPageCoverage, 0);
  assert.equal(legacy.confluenceReviewCoverage, undefined);
});
