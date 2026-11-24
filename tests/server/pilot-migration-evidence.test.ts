import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectMigrationEvidence, compareMigrationEvidence } from '../../scripts/pilot-migration-evidence.mjs';

const jira = {
  packageId: '00000000-0000-0000-0000-000000000011', product: 'jira', format: 'jira-json', sha256: 'a'.repeat(64),
  instanceKey: 'never-emit-private-jira-instance', size: 25, errors: 0, warnings: 2, counts: { issue: 1 },
};
const wiki = {
  packageId: '00000000-0000-0000-0000-000000000012', product: 'confluence', format: 'confluence-xml', sha256: 'b'.repeat(64),
  instanceKey: 'never-emit-private-wiki-instance', size: 35, errors: 0, warnings: 0, counts: { page: 1 },
};
const completeWikiReview = {
  proof: { packageId: wiki.packageId, version: 2, sha256: '9'.repeat(64), status: 'matched' as const,
    coverage: { archivePages: 1, permissionCheckedPages: 1 } },
  findings: { status: 'matched' as const, archive: { sha256: wiki.sha256, bytes: wiki.size }, findings: [] },
};
const receiptId = '00000000-0000-0000-0000-000000000020';
const archivedId = '00000000-0000-0000-0000-000000000030';
const fileId = '00000000-0000-0000-0000-000000000040';
const recordCounts = { linked: 4, trashed: 0, missing: 0, 'archive-only': 1, excluded: 0 };
const primaryCounts = { linked: 1, trashed: 0, missing: 0, 'archive-only': 0, excluded: 0 };
const attachmentCounts = { verified: 1, missing: 0, corrupt: 0, unbound: 0, excluded: 0, unreadable: 0 };
const targetDigests = {
  comments: { count: 1, sha256: '1'.repeat(64) },
  revisions: { count: 1, sha256: '2'.repeat(64) },
  worklogs: { count: 1, sha256: '3'.repeat(64) },
  issueRelations: { count: 1, sha256: '4'.repeat(64) },
};
const statusHistory = { sourceChanges: 2, projected: { count: 1, sha256: '5'.repeat(64) }, duplicate: 1, excluded: 0,
  restricted: 0, unavailable: 0, unresolvedTime: 0, unresolvedAuthor: 0 };

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
  notices = [] as ReceiptNotice[] | null, wikiOnly = false } = {}) {
  const packages: Parameters<typeof collectMigrationEvidence>[1] = wikiOnly ? [wiki] : [jira, wiki];
  const receipt = {
    id: receiptId, version, projectIds: ['project-synthetic'], configuration: { users: { original: changedOwner ? 'team-2' : 'team-1' } },
    packages: packages.map(({ packageId, sha256, product, instanceKey, format }) => ({ stagingId: packageId,
      sha256, source: { product, instanceKey, format }, filename: '/private/never-emit-export.zip' })),
    ...(notices === null ? {} : { notices }),
  };
  const observations = {
    importId: receiptId, receiptVersion: version, startedAt: `synthetic-time-${version}`,
    integrity: { status: 'verified', records: { expected: 5, observed: 5 }, boundAttachments: { expected: 1, observed: 1 },
      unmatchedRecords: 0, columnMismatches: 0, packages: packages.map(({ packageId, product }, index) => ({
        stagingId: packageId, status: 'verified', filename: '/private/never-emit-export.zip',
        records: { expected: wikiOnly ? 5 : index + 2, observed: wikiOnly ? 5 : index + 2 },
        boundAttachments: { expected: Number(product === 'confluence'), observed: Number(product === 'confluence') },
        recordsSha256: { expected: 'd'.repeat(64), observed: 'd'.repeat(64) },
      })) },
    recordCounts,
    primaryRecords: packages.map(({ packageId, product }) => ({ packageId, kind: product === 'jira' ? 'issue' : 'page',
      counts: { ...primaryCounts }, invalidTargets: 0, dispositionSha256: 'e'.repeat(64), title: 'never-emit-private-primary-title' })),
    attachmentCounts: corrupt ? { ...attachmentCounts, verified: 0, corrupt: 1 } : attachmentCounts,
    attachments: [{ sourceRecordId: archivedId, fileId, recordStatus: 'linked', status: corrupt ? 'corrupt' : 'verified',
      packageSha256: wiki.sha256, product: wiki.product, sourceInstance: wiki.instanceKey, size: 11,
      sha256: corrupt ? 'never-emit-invalid-file-metadata' : 'c'.repeat(64), title: 'never-emit-original-file-title' }],
    targetContent: { version: 1, ...targetDigests, comments: { ...targetDigests.comments, body: 'never-emit-comment' },
      documentHistory: 'never-emit-unexpected-target-section' },
    jiraStatusHistory: wikiOnly ? null : { ...statusHistory,
      projected: { ...statusHistory.projected, author: 'never-emit-jira-history-author' }, originalLabel: 'never-emit-jira-history-status' },
  };
  const workspace = {
    projects: [{ id: 'project-synthetic', name: 'never-emit-private-project-name' }],
    users: [{ id: 'team-1', email: 'never-emit-private-email@example.test' }, { id: 'team-2' }],
    issues: [{ id: 'issue-1', assigneeId: 'team-1', description: 'never-emit-issue-description' }],
    documents: [{ id: 'document-1', projectId: 'project-synthetic', parentId: null,
      authorId: swappedAuthors ? 'team-2' : 'team-1', content: { text: 'never-emit-document-body' } }],
    documentOrders: [{ projectId: 'project-synthetic', parentId: null, documentIds: ['document-1'] }],
    workflows: [], issueSchemas: [], dependencies: [], resourceLinks: [{ id: 'res-link', documentId: 'document-1', issueId: 'issue-1' }],
    planningItems: [{ id: 'plan-1', kind: 'release', name: 'never-emit-private-release', targetDate: '2026-01-01' }],
  };
  return { packages, receipt, observations, workspace };
}

function evidence(input: ReturnType<typeof sample>, observations: unknown = input.observations) {
  return collectMigrationEvidence(async path => {
    if (path === '/source-imports') return [input.receipt];
    if (path === '/workspace') return input.workspace;
    assert.equal(path, `/source-imports/${receiptId}/reconciliation/audit?expectedVersion=${input.receipt.version}`);
    return observations;
  }, input.packages, [completeWikiReview]);
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
  assert.equal(before.receipts[0].recordCounts['archive-only'], 1, 'archive-only reference data does not delay verification');
  assert.equal(before.checks.receiptsWithArchiveOnlyPrimaryRecords, 0);
  assert.deepEqual(before.receipts[0].primaryRecords, [
    { packageId: jira.packageId, kind: 'issue', counts: primaryCounts, invalidTargets: 0, dispositionSha256: 'e'.repeat(64),
      records: { expected: 1, observed: 1 } },
    { packageId: wiki.packageId, kind: 'page', counts: primaryCounts, invalidTargets: 0, dispositionSha256: 'e'.repeat(64),
      records: { expected: 1, observed: 1 } },
  ]);
  assert.deepEqual(before.receipts[0].targetContent, { version: 1, ...targetDigests });
  assert.deepEqual(before.receipts[0].jiraStatusHistory, statusHistory);
  assert.equal(before.checks.receiptsWithJiraHistoryReview, 0);
  assert.equal(before.workspace.counts.documents, 1);
  assert.equal(before.workspace.counts.planningItems, 1);
  assert.doesNotMatch(JSON.stringify(before), /never-emit|\/private\//);
  assert.deepEqual(compareMigrationEvidence(before, after), {
    status: 'verified', matches: true, changedReceiptIds: [], workspaceMatches: true, packagesMatch: true,
  });
  const changed = await evidence(sample({ changedOwner: true, swappedAuthors: true, notices: [info] }));
  assert.deepEqual(compareMigrationEvidence(before, changed), {
    status: 'failed', matches: false, changedReceiptIds: [receiptId], workspaceMatches: false, packagesMatch: true,
  });
  const differentRelease = sample({ notices: [info] });
  differentRelease.workspace.planningItems[0].targetDate = '2026-01-02';
  const releaseComparison = compareMigrationEvidence(before, await evidence(differentRelease));
  assert.equal(releaseComparison.workspaceMatches, false);
  assert.equal(releaseComparison.status, 'failed');
});

test('migration rehearsal distinguishes archive-only primary records from hard coverage failures', async () => {
  const input = sample();
  const [jiraProof, wikiProof] = input.observations.primaryRecords;
  const archiveOnly = { ...jiraProof, counts: { ...primaryCounts, linked: 0, 'archive-only': 1 } };
  const observations = { ...input.observations, primaryRecords: [wikiProof, archiveOnly] };
  const review = await evidence(input, observations);
  assert.equal(review.status, 'review');
  assert.equal(review.checks.receiptsWithArchiveOnlyPrimaryRecords, 1);
  assert.equal(review.checks.receiptsWithPrimaryRecordCountMismatches, 0);
  assert.equal(review.receipts[0].primaryRecords[0].packageId, jira.packageId, 'proof uses stable package order');
  assert.equal(review.receipts[0].primaryRecords[0].counts['archive-only'], 1);
  assert.deepEqual(review.receipts[0].recordCounts, recordCounts, 'same aggregate counts can hide a change of disposition');

  input.packages = [{ ...jira, counts: { issue: 2 } }, wiki];
  const countMismatch = await evidence(input, observations);
  assert.equal(countMismatch.status, 'failed');
  assert.equal(countMismatch.checks.receiptsWithPrimaryRecordCountMismatches, 1);
  assert.deepEqual(countMismatch.receipts[0].primaryRecords[0].records, { expected: 2, observed: 1 });
  const restore = compareMigrationEvidence(countMismatch, await evidence(input, observations));
  assert.equal(restore.matches, true);
  assert.equal(restore.status, 'failed');

  input.packages = [jira, wiki];
  const invalid = await evidence(input, { ...observations, primaryRecords: [jiraProof, { ...wikiProof, invalidTargets: 1 }] });
  assert.equal(invalid.status, 'failed');
  assert.equal(invalid.checks.receiptsWithInvalidPrimaryTargets, 1);
  assert.equal(invalid.checks.receiptsWithPrimaryRecordCountMismatches, 0);
  assert.equal(invalid.receipts[0].primaryRecords[1].invalidTargets, 1);
});

test('migration rehearsal requires complete and consistent coverage rows, including packages with zero primary records', async () => {
  const input = sample();
  const [jiraProof, wikiProof] = input.observations.primaryRecords;
  const readPrimary = (primaryRecords: unknown) => evidence(input, { ...input.observations, primaryRecords });
  const invalidProofs = [
    undefined,
    [jiraProof],
    [jiraProof, jiraProof],
    [jiraProof, { ...wikiProof, packageId: '00000000-0000-0000-0000-000000000099' }],
    [{ ...jiraProof, kind: 'page' }, wikiProof],
    [{ ...jiraProof, dispositionSha256: 'not-a-digest' }, wikiProof],
    [{ ...jiraProof, invalidTargets: 2 }, wikiProof],
    [{ ...jiraProof, counts: { ...primaryCounts, linked: 3 } }, wikiProof],
    [{ ...jiraProof, counts: { ...primaryCounts, 'archive-only': 2, linked: 0 } }, wikiProof],
    [{ ...jiraProof, counts: { ...primaryCounts, linked: 0.5 } }, wikiProof],
  ];
  for (const invalid of invalidProofs) await assert.rejects(readPrimary(invalid), /검증 (결과|건수)/u);

  input.packages = [jira, { ...wiki, counts: {} }];
  const zero = await readPrimary([jiraProof, { ...wikiProof, counts: { ...primaryCounts, linked: 0 } }]);
  assert.equal(zero.status, 'verified');
  assert.deepEqual(zero.receipts[0].primaryRecords[1].records, { expected: 0, observed: 0 });
  input.packages = [jira, { ...wiki, counts: { page: -1 } }];
  await assert.rejects(evidence(input), /이관 준비 기록의 업무·문서 분석 건수/u);
});

test('migration rehearsal detects changed primary dispositions even when counts and workspace match', async () => {
  const input = sample();
  const [jiraProof, wikiProof] = input.observations.primaryRecords;
  const before = await evidence(input);
  const after = await evidence(input, { ...input.observations, primaryRecords: [wikiProof, { ...jiraProof, dispositionSha256: 'f'.repeat(64) }] });
  assert.equal(before.status, 'verified');
  assert.equal(after.status, 'verified');
  assert.deepEqual(compareMigrationEvidence(before, after), {
    status: 'failed', matches: false, changedReceiptIds: [receiptId], workspaceMatches: true, packagesMatch: true,
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

test('Jira status projection differences fail restore comparison at unchanged counts and workspace', async () => {
  const input = sample();
  const before = await evidence(input);
  const changed = await evidence(input, { ...input.observations, jiraStatusHistory: { ...statusHistory,
    projected: { ...statusHistory.projected, sha256: 'f'.repeat(64) } } });
  assert.equal(changed.status, 'verified');
  assert.deepEqual(compareMigrationEvidence(before, changed), {
    status: 'failed', matches: false, changedReceiptIds: [receiptId], workspaceMatches: true, packagesMatch: true,
  });
});

test('Jira status history flags unresolved evidence for review and validates receipt scope and counts', async () => {
  const input = sample();
  const readHistory = (jiraStatusHistory: unknown) => evidence(input, { ...input.observations, jiraStatusHistory });
  for (const extra of [{ restricted: 1, duplicate: 0 }, { unavailable: 1, duplicate: 0 }, { unresolvedTime: 1 }, { unresolvedAuthor: 1 }]) {
    const review = await readHistory({ ...statusHistory, ...extra });
    assert.equal(review.status, 'review');
    assert.equal(review.checks.receiptsWithJiraHistoryReview, 1);
  }
  for (const invalid of [undefined, null, { ...statusHistory, sourceChanges: 1 }, { ...statusHistory, unavailable: -1 },
    { ...statusHistory, unresolvedAuthor: 2 }, { ...statusHistory, projected: { count: 1, sha256: '/private/invalid' } }]) {
    await assert.rejects(readHistory(invalid), /Jira 상태 이력의 검증 건수 또는 해시/);
  }

  const wiki = sample({ wikiOnly: true });
  const wikiEvidence = await evidence(wiki);
  assert.equal(wikiEvidence.status, 'verified');
  assert.equal(wikiEvidence.receipts[0].jiraStatusHistory, null);
  await assert.rejects(evidence(wiki, { ...wiki.observations, jiraStatusHistory: statusHistory }), /Jira 상태 이력의 검증 건수 또는 해시/);
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

const reviewedPageIds = ['100000000000000001', '100000000000000002', '100000000000000003', '100000000000000004', '100000000000000005'];
const reviewDispositionCounts = { excluded: 2, documentBound: 1, archiveOnly: 1, absent: 1 };
const emptyDispositions = { excluded: 0, documentBound: 0, archiveOnly: 0, absent: 0 };

function confluenceReview(sha256: string, pageIds: string[], codes = ['LIVE_RESTRICTED']) {
  const status = pageIds.length ? 'needs-review' as const : 'matched' as const;
  return {
    proof: { packageId: wiki.packageId, sha256, status },
    findings: { status, archive: { sha256: wiki.sha256, bytes: wiki.size },
      findings: pageIds.map(pageId => ({ pageId, codes })) },
  };
}

function reviewedPage(sourceId: string, extras: Record<string, unknown> = {}) {
  return {
    sourceImportId: receiptId, packageSha256: wiki.sha256,
    source: { product: wiki.product, instanceKey: wiki.instanceKey, format: wiki.format },
    record: { id: `page:${sourceId}`, kind: 'page', sourceId, title: 'never-emit-private-source-page' },
    targetType: null, targetId: null, ...extras,
  };
}

function confluenceEvidence(rows: ReturnType<typeof reviewedPage>[], reviews: ReturnType<typeof confluenceReview>[],
  offsets: number[] = [], alterPage = (page: object) => page, version = 1) {
  const input = sample({ version });
  const receipt = { ...input.receipt, configuration: {
    ...input.receipt.configuration, excludedRecords: [`${wiki.packageId}/page:${reviewedPageIds[2]}`],
  } };
  const previousCount = input.observations.integrity.records.observed;
  const total = Math.max(previousCount, rows.length + 1);
  const extra = total - previousCount;
  const observations = {
    ...input.observations, recordCounts: { ...input.observations.recordCounts, linked: input.observations.recordCounts.linked + extra },
    integrity: { ...input.observations.integrity, records: { expected: total, observed: total }, packages:
      input.observations.integrity.packages.map(pkg => pkg.stagingId === wiki.packageId ? {
        ...pkg, records: { expected: pkg.records.expected + extra, observed: pkg.records.observed + extra },
      } : pkg) },
  };
  return collectMigrationEvidence(async path => {
    if (path === '/source-imports') return [receipt];
    if (path === '/workspace') return input.workspace;
    if (path === `/source-imports/${receiptId}/reconciliation/audit?expectedVersion=${version}`) return observations;
    assert.match(path, new RegExp(`^/source-imports/${receiptId}/records\\?kind=page&offset=\\d+&limit=100$`));
    const offset = Number(new URL(path, 'http://localhost').searchParams.get('offset'));
    offsets.push(offset);
    return alterPage({ records: rows.slice(offset, offset + 100), total: rows.length, offset, limit: 100 });
  }, input.packages, reviews);
}

test('Confluence findings use exact receipt package identities, one page scan, and a private disposition digest', async () => {
  const [bound, inheritedExclusion, explicitExclusion, archiveOnly, absent] = reviewedPageIds;
  const rows = [
    reviewedPage(absent, { packageSha256: 'e'.repeat(64), targetType: 'document', targetId: 'wrong-zip-document' }),
    reviewedPage(absent, { source: { product: wiki.product, instanceKey: 'another-instance', format: wiki.format },
      targetType: 'document', targetId: 'wrong-instance-document' }),
    ...Array.from({ length: 98 }, (_, index) => reviewedPage(String(index + 1))),
    reviewedPage(bound, { targetType: 'document', targetId: 'team-document' }),
    reviewedPage(inheritedExclusion, { excluded: true }),
    reviewedPage(explicitExclusion),
    reviewedPage(archiveOnly),
  ];
  const offsets: number[] = [];
  const reviews = [confluenceReview('9'.repeat(64), reviewedPageIds), confluenceReview('8'.repeat(64), [bound, absent])];
  const before = await confluenceEvidence(rows, reviews, offsets);
  assert.deepEqual(offsets, [0, 100]);
  assert.equal(before.status, 'failed');
  assert.equal(before.checks.receiptsWithLiveRestrictedConfluenceDocuments, 1);
  assert.equal(before.receipts[0].liveRestrictedConfluenceDocumentCount, 1);
  const observed = before.receipts[0].confluenceReviews;
  const dispositions = [{ ...emptyDispositions, documentBound: 1, absent: 1 }, reviewDispositionCounts];
  assert.deepEqual(observed?.map(({ counts }) => counts), dispositions);
  assert.deepEqual(observed?.map(({ liveRestrictedCounts }) => liveRestrictedCounts), dispositions);
  assert.ok(observed?.every(({ dispositionsSha256 }) => /^[a-f0-9]{64}$/u.test(dispositionsSha256)));
  assert.doesNotMatch(JSON.stringify(before), /10000000000000000[1-5]|never-emit|team-document|wrong-.*-document/);
  const after = await confluenceEvidence([...rows].reverse(), [...reviews].reverse(), [], undefined, 2);
  assert.equal(compareMigrationEvidence(before, after).matches, true);

  const changed = await confluenceEvidence([...rows.slice(0, -4), reviewedPage(bound), ...rows.slice(-3, -1),
    reviewedPage(archiveOnly, { targetType: 'document', targetId: 'team-document' })], reviews);
  assert.deepEqual(changed.receipts[0].confluenceReviews?.[1].counts, reviewDispositionCounts);
  assert.deepEqual(compareMigrationEvidence(before, changed).changedReceiptIds, [receiptId]);
});

test('Confluence unconfirmed restrictions remain under review and a document binding overrides a conflicting exclusion for confirmed restrictions', async () => {
  const [bound, inheritedExclusion, explicitExclusion, archiveOnly, absent] = reviewedPageIds;
  const confirmed = confluenceReview('9'.repeat(64), [inheritedExclusion, explicitExclusion, archiveOnly, absent]);
  const unconfirmed = confluenceReview('8'.repeat(64), [bound], ['LIVE_RESTRICTION_UNKNOWN', 'RESTRICTION_MISMATCH']);
  const rows = [
    reviewedPage(bound, { targetType: 'document', targetId: 'unconfirmed-team-document' }),
    reviewedPage(inheritedExclusion, { excluded: true }),
    reviewedPage(explicitExclusion),
    reviewedPage(archiveOnly),
  ];
  const before = await confluenceEvidence(rows, [confirmed, unconfirmed]);
  assert.equal(before.status, 'review');
  assert.equal(before.checks.receiptsWithLiveRestrictedConfluenceDocuments, 0);
  const reviewed = before.receipts[0].confluenceReviews;
  assert.deepEqual(reviewed?.[0].counts, { ...emptyDispositions, documentBound: 1 });
  assert.deepEqual(reviewed?.[0].liveRestrictedCounts, emptyDispositions);
  assert.deepEqual(reviewed?.[1].liveRestrictedCounts, { ...reviewDispositionCounts, documentBound: 0 });

  rows[2] = reviewedPage(explicitExclusion, { excluded: true, targetType: 'document', targetId: 'restricted-live-document' });
  const after = await confluenceEvidence(rows, [confirmed, unconfirmed]);
  assert.equal(after.status, 'failed');
  assert.equal(after.checks.receiptsWithLiveRestrictedConfluenceDocuments, 1);
  assert.equal(after.receipts[0].liveRestrictedConfluenceDocumentCount, 1);
  assert.deepEqual(after.receipts[0].confluenceReviews?.[1].counts, reviewed?.[1].counts);
  assert.deepEqual(after.receipts[0].confluenceReviews?.[1].liveRestrictedCounts, { excluded: 1, documentBound: 1, archiveOnly: 1, absent: 1 });
  assert.deepEqual(compareMigrationEvidence(before, after).changedReceiptIds, [receiptId]);
  assert.doesNotMatch(JSON.stringify(after), /10000000000000000[1-5]|never-emit|restricted-live-document/);
});

test('Confluence live restrictions follow the same source instance into a different package and receipt', async () => {
  const [pageId] = reviewedPageIds;
  const input = sample({ wikiOnly: true });
  const alternateSha256 = 'e'.repeat(64);
  const review = confluenceReview('9'.repeat(64), [pageId], ['LIVE_RESTRICTED', 'MISSING_FROM_ARCHIVE']);
  let pageScans = 0;
  function run(instanceKey: string) {
    const source = { ...input.receipt.packages[0].source, instanceKey };
    const receipt = { ...input.receipt, packages: [{
      ...input.receipt.packages[0], stagingId: '00000000-0000-0000-0000-000000000015', sha256: alternateSha256, source,
    }] };
    const row = reviewedPage(pageId, { packageSha256: alternateSha256, source, targetType: 'document', targetId: 'another-team-document' });
    return collectMigrationEvidence(async path => {
      if (path === '/source-imports') return [receipt];
      if (path === '/workspace') return input.workspace;
      assert.equal(path, `/source-imports/${receiptId}/records?kind=page&offset=0&limit=100`);
      pageScans++;
      return { records: [row], total: 1, offset: 0, limit: 100 };
    }, [wiki], [review]);
  }
  const otherZip = await run(wiki.instanceKey);
  assert.equal(otherZip.status, 'failed');
  assert.equal(otherZip.checks.receiptsWithLiveRestrictedConfluenceDocuments, 1);
  assert.equal(otherZip.checks.unexpectedReceipts, 1);
  assert.equal(otherZip.checks.pendingPackages, 1);
  assert.doesNotMatch(JSON.stringify(otherZip), /100000000000000001|never-emit|another-team-document/);
  const otherInstance = await run('never-emit-another-wiki-instance');
  assert.equal(otherInstance.status, 'review');
  assert.equal(otherInstance.checks.receiptsWithLiveRestrictedConfluenceDocuments, 0);
  assert.equal(pageScans, 1);
});

test('Confluence matched findings need coverage evidence before counting a package as fully checked', async () => {
  const matched = confluenceReview('9'.repeat(64), []);
  const offsets: number[] = [];
  const result = await confluenceEvidence([], [matched], offsets);
  assert.deepEqual(offsets, []);
  assert.equal(result.status, 'review');
  assert.equal(result.checks.confluencePackagesWithoutFullPageCoverage, 1);
  assert.deepEqual(result.receipts[0].confluenceReviews?.[0].counts, emptyDispositions);
  assert.deepEqual(result.receipts[0].confluenceReviews?.[0].liveRestrictedCounts, emptyDispositions);

  const partial = { ...matched, proof: { ...matched.proof, version: 2, coverage: { archivePages: 2, permissionCheckedPages: 1 } } };
  const separate = { ...partial, proof: { ...partial.proof, sha256: '7'.repeat(64) } };
  const partialResult = await confluenceEvidence([], [partial, separate], offsets);
  assert.equal(partialResult.status, 'review');
  assert.equal(partialResult.checks.confluencePackagesWithoutFullPageCoverage, 1);

  const full = { ...matched, proof: { ...matched.proof, version: 2, sha256: '6'.repeat(64), coverage: { archivePages: 2, permissionCheckedPages: 2 } } };
  const fullResult = await confluenceEvidence([], [partial, full], offsets);
  assert.equal(fullResult.status, 'verified');
  assert.equal(fullResult.checks.confluencePackagesWithoutFullPageCoverage, 0);
  assert.deepEqual(offsets, []);
});

test('Confluence verification rejects malformed page evidence', async () => {
  const review = confluenceReview('8'.repeat(64), [reviewedPageIds[0]]);
  await assert.rejects(confluenceEvidence([reviewedPage(reviewedPageIds[0])], [review], [], page => ({ ...page, total: 9000 })),
    /Confluence 페이지별 검토의 영수증 원본 목록/);
});
