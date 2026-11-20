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
const targetDigests = {
  comments: { count: 1, sha256: '1'.repeat(64) },
  revisions: { count: 1, sha256: '2'.repeat(64) },
  worklogs: { count: 1, sha256: '3'.repeat(64) },
  issueRelations: { count: 1, sha256: '4'.repeat(64) },
};

interface ReceiptNotice {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  recordId: string;
}

const warning: ReceiptNotice = {
  code: 'SOURCE_EXAMPLE', severity: 'warning', message: 'never-emit-original-private-notice', recordId: 'never-emit-original-key',
};
const info: ReceiptNotice = { ...warning, severity: 'info', code: 'SOURCE_DETAIL' };

function sample({ version = 1, corrupt = false, changedOwner = false, swappedAuthors = false,
  notices = [] as ReceiptNotice[] | null } = {}) {
  const packages = [jira, wiki];
  const receipt = {
    id: receiptId, version, projectIds: ['project-synthetic'], configuration: { users: { original: changedOwner ? 'team-2' : 'team-1' } },
    packages: packages.map(({ packageId, sha256, product, instanceKey, format }) => ({ stagingId: packageId,
      sha256, source: { product, instanceKey, format }, filename: '/private/never-emit-export.zip' })),
    ...(notices === null ? {} : { notices }),
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
    targetContent: { version: 1, ...targetDigests, comments: { ...targetDigests.comments, body: 'never-emit-comment' },
      documentHistory: 'never-emit-unexpected-target-section' },
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

function evidence(input: ReturnType<typeof sample>, observations: unknown = input.observations) {
  return collectMigrationEvidence(async path => {
    if (path === '/source-imports') return [input.receipt];
    if (path === '/workspace') return input.workspace;
    assert.equal(path, `/source-imports/${receiptId}/reconciliation/audit?expectedVersion=${input.receipt.version}`);
    return observations;
  }, input.packages);
}

test('migration rehearsal proves package coverage and matching cold-restore evidence without emitting contents', async () => {
  const before = await evidence(sample({ notices: [info] }));
  const after = await evidence(sample({ version: 2, notices: [info] }));
  assert.equal(before.status, 'verified');
  assert.deepEqual(before.packages.map(pkg => pkg.receiptIds), [[receiptId], [receiptId]]);
  assert.equal(before.packages[0].warnings, 2);
  assert.equal(before.checks.receiptsWithWarnings, 0);
  assert.equal(before.receipts[0].noticesAvailable, true);
  assert.equal(before.receipts[0].attachmentCounts.verified, 1);
  assert.deepEqual(before.receipts[0].targetContent, { version: 1, ...targetDigests });
  assert.equal(before.workspace.counts.documents, 1);
  assert.doesNotMatch(JSON.stringify(before), /never-emit|\/private\//);
  assert.deepEqual(compareMigrationEvidence(before, after), {
    status: 'verified', matches: true, changedReceiptIds: [], workspaceMatches: true, packagesMatch: true,
  });
  const changed = await evidence(sample({ changedOwner: true, swappedAuthors: true, notices: [info] }));
  assert.deepEqual(compareMigrationEvidence(before, changed), {
    status: 'failed', matches: false, changedReceiptIds: [receiptId], workspaceMatches: false, packagesMatch: true,
  });
});

test('migration rehearsal reports applied warnings by receipt even when the cold restore matches', async () => {
  const notices = [warning, warning, info,
    { ...warning, code: '/private/never-emit-invalid-notice-code' }];
  const before = await evidence(sample({ notices }));
  const after = await evidence(sample({ version: 2, notices }));
  assert.equal(before.status, 'review');
  assert.equal(before.checks.receiptsWithWarnings, 1);
  assert.equal(before.receipts[0].id, receiptId);
  assert.equal(before.receipts[0].noticesAvailable, true);
  assert.deepEqual(before.receipts[0].notices, [
    { severity: 'info', code: 'SOURCE_DETAIL', count: 1 },
    { severity: 'warning', code: 'SOURCE_EXAMPLE', count: 2 },
    { severity: 'warning', code: 'UNRECOGNIZED_NOTICE_CODE', count: 1 },
  ]);
  assert.doesNotMatch(JSON.stringify(before), /never-emit|\/private\//);
  assert.deepEqual(compareMigrationEvidence(before, after), {
    status: 'review', matches: true, changedReceiptIds: [], workspaceMatches: true, packagesMatch: true,
  });
  const error = await evidence(sample({ notices: [warning, { ...warning, severity: 'error', code: 'UNEXPECTED_ERROR' }] }));
  assert.equal(error.status, 'failed');
});

test('migration rehearsal requires review when older receipts have no saved diagnostics', async () => {
  const before = await evidence(sample({ notices: null }));
  const after = await evidence(sample({ version: 2, notices: null }));
  assert.equal(before.status, 'review');
  assert.equal(before.checks.receiptsWithoutNotices, 1);
  assert.equal(before.receipts[0].id, receiptId);
  assert.equal(before.receipts[0].noticesAvailable, false);
  assert.deepEqual(before.receipts[0].notices, []);
  assert.equal(compareMigrationEvidence(before, after).status, 'review');
});

test('migration rehearsal detects changed target contents even when restored counts and workspace match', async () => {
  const input = sample();
  const before = await evidence(input);
  for (const [section, original] of Object.entries(targetDigests)) {
    const after = await evidence(input, { ...input.observations, targetContent: {
      ...input.observations.targetContent, [section]: { ...original, sha256: 'f'.repeat(64) },
    } });
    assert.equal(after.status, 'verified');
    assert.deepEqual(after.receipts[0].recordCounts, before.receipts[0].recordCounts);
    assert.deepEqual(compareMigrationEvidence(before, after), {
      status: 'failed', matches: false, changedReceiptIds: [receiptId], workspaceMatches: true, packagesMatch: true,
    }, section);
  }
});

test('migration rehearsal rejects absent or malformed target-content evidence', async () => {
  const input = sample();
  const { targetContent, ...withoutTarget } = input.observations;
  await assert.rejects(evidence(input, withoutTarget), /이관 대상 내용 검증 형식 또는 버전/);
  await assert.rejects(evidence(input, { ...input.observations, targetContent: { ...targetContent, version: 2 } }), /이관 대상 내용 검증 형식 또는 버전/);
  const malformed = {
    comments: undefined, revisions: [], worklogs: { ...targetDigests.worklogs, count: -1 },
    issueRelations: { ...targetDigests.issueRelations, sha256: 'never-emit-invalid-digest' },
  };
  for (const [section, value] of Object.entries(malformed)) {
    await assert.rejects(evidence(input, { ...input.observations, targetContent: { ...targetContent, [section]: value } }),
      { message: `이관 대상 내용 검증 항목(${section})의 건수 또는 해시가 올바르지 않습니다.` });
  }
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

  const corrupt = await evidence(sample({ corrupt: true, notices: [warning] }));
  assert.equal(corrupt.status, 'failed');
  assert.equal(corrupt.checks.receiptsWithWarnings, 1);
  assert.equal(corrupt.receipts[0].attachmentCounts.corrupt, 1);
  assert.doesNotMatch(JSON.stringify(corrupt), /never-emit/);
  assert.deepEqual(compareMigrationEvidence(await evidence(sample()), corrupt).changedReceiptIds, [receiptId]);
});
