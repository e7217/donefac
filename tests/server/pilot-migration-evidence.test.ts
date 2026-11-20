import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectMigrationEvidence, compareMigrationEvidence } from '../../scripts/pilot-migration-evidence.mjs';

const jira = {
  packageId: '00000000-0000-0000-0000-000000000011', product: 'jira', format: 'jira-json', sha256: 'a'.repeat(64),
  instanceKey: 'never-emit-private-jira-instance', size: 25, errors: 0, warnings: 2,
};
const wiki = {
  packageId: '00000000-0000-0000-0000-000000000012', product: 'confluence', format: 'confluence-xml', sha256: 'b'.repeat(64),
  instanceKey: 'never-emit-private-wiki-instance', size: 35, errors: 0, warnings: 0,
};
const receiptId = '00000000-0000-0000-0000-000000000020';
const archivedId = '00000000-0000-0000-0000-000000000030';
const fileId = '00000000-0000-0000-0000-000000000040';
const recordCounts = { linked: 4, trashed: 0, missing: 0, 'archive-only': 1, excluded: 0 };
const attachmentCounts = { verified: 1, missing: 0, corrupt: 0, unbound: 0, excluded: 0, unreadable: 0 };

function sample({ version = 1, corrupt = false, changedOwner = false, swappedAuthors = false } = {}) {
  const packages = [jira, wiki];
  const receipt = {
    id: receiptId, version, projectIds: ['project-synthetic'], configuration: { users: { original: changedOwner ? 'team-2' : 'team-1' } },
    packages: packages.map(({ packageId, sha256, product, instanceKey, format }) => ({ stagingId: packageId,
      sha256, source: { product, instanceKey, format }, filename: '/private/never-emit-export.zip' })),
    notices: [{ code: 'SOURCE_EXAMPLE', severity: 'warning', message: 'never-emit-original-private-notice', recordId: 'never-emit-original-key' }],
  };
  const observations = {
    importId: receiptId, receiptVersion: version, startedAt: `synthetic-time-${version}`,
    integrity: { status: 'verified', records: { expected: 5, observed: 5 }, boundAttachments: { expected: 1, observed: 1 },
      unmatchedRecords: 0, columnMismatches: 0, packages: packages.map(({ packageId }, index) => ({
        stagingId: packageId, status: 'verified', filename: '/private/never-emit-export.zip',
        records: { expected: index + 2, observed: index + 2 }, boundAttachments: { expected: index, observed: index },
        recordsSha256: { expected: 'd'.repeat(64), observed: 'd'.repeat(64) },
      })) },
    recordCounts,
    attachmentCounts: corrupt ? { ...attachmentCounts, verified: 0, corrupt: 1 } : attachmentCounts,
    attachments: [{ sourceRecordId: archivedId, fileId, recordStatus: 'linked', status: corrupt ? 'corrupt' : 'verified',
      packageSha256: wiki.sha256, product: wiki.product, sourceInstance: wiki.instanceKey, size: 11,
      sha256: corrupt ? 'never-emit-invalid-file-metadata' : 'c'.repeat(64), title: 'never-emit-original-file-title' }],
  };
  const workspace = {
    projects: [{ id: 'project-synthetic', name: 'never-emit-private-project-name' }],
    users: [{ id: 'team-1', email: 'never-emit-private-email@example.test' }, { id: 'team-2' }],
    issues: [{ id: 'issue-1', assigneeId: 'team-1', description: 'never-emit-issue-description' }],
    documents: [{ id: 'document-1', authorId: swappedAuthors ? 'team-2' : 'team-1', content: { text: 'never-emit-document-body' } }],
    workflows: [], issueSchemas: [], dependencies: [], resourceLinks: [{ id: 'res-link', documentId: 'document-1', issueId: 'issue-1' }],
  };
  return { packages, receipt, observations, workspace };
}

function evidence(input: ReturnType<typeof sample>) {
  return collectMigrationEvidence(async path => {
    if (path === '/source-imports') return [input.receipt];
    if (path === '/workspace') return input.workspace;
    assert.equal(path, `/source-imports/${receiptId}/reconciliation/audit?expectedVersion=${input.receipt.version}`);
    return input.observations;
  }, input.packages);
}

test('migration rehearsal proves package coverage and matching cold-restore evidence without emitting contents', async () => {
  const before = await evidence(sample());
  const after = await evidence(sample({ version: 2 }));
  assert.equal(before.status, 'verified');
  assert.deepEqual(before.packages.map(pkg => pkg.receiptIds), [[receiptId], [receiptId]]);
  assert.equal(before.receipts[0].attachmentCounts.verified, 1);
  assert.equal(before.workspace.counts.documents, 1);
  assert.doesNotMatch(JSON.stringify(before), /never-emit|\/private\//);
  assert.deepEqual(compareMigrationEvidence(before, after), {
    status: 'verified', matches: true, changedReceiptIds: [], workspaceMatches: true, packagesMatch: true,
  });
  const changed = await evidence(sample({ changedOwner: true, swappedAuthors: true }));
  assert.deepEqual(compareMigrationEvidence(before, changed), {
    status: 'failed', matches: false, changedReceiptIds: [receiptId], workspaceMatches: false, packagesMatch: true,
  });
});

test('migration rehearsal surfaces pending stages, conflicted package identities, and corrupt files', async () => {
  const pendingData = sample();
  const pending = await collectMigrationEvidence(async path => path === '/source-imports' ? [] : pendingData.workspace, pendingData.packages);
  assert.equal(pending.status, 'review');
  assert.equal(pending.checks.pendingPackages, 2);

  const mismatched = sample();
  mismatched.receipt.packages[0].source.instanceKey = 'different-instance';
  const rejected = await evidence(mismatched);
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.checks.sourceIdentityMismatches, 1);
  assert.deepEqual(rejected.packages[0].receiptIds, []);

  const corrupt = await evidence(sample({ corrupt: true }));
  assert.equal(corrupt.status, 'failed');
  assert.equal(corrupt.receipts[0].attachmentCounts.corrupt, 1);
  assert.doesNotMatch(JSON.stringify(corrupt), /never-emit/);
  assert.deepEqual(compareMigrationEvidence(await evidence(sample()), corrupt).changedReceiptIds, [receiptId]);
});
