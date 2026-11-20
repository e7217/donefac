import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildMigrationPreflightReport } from '../../shared/migration-preflight.js';
import type { LegacyPackageSummary, MigrationPreview } from '../../shared/types.js';

const previewId = '00000000-0000-0000-0000-000000000030';
const packageId = '00000000-0000-0000-0000-000000000031';
const unrelatedPackageId = '00000000-0000-0000-0000-000000000032';
const jira: LegacyPackageSummary = {
  id: packageId, filename: '/private/never-emit-report.zip', sha256: 'd'.repeat(64), size: 4000, version: 1,
  createdAt: '2026-11-20T00:00:00.000Z', actorId: 'never-emit-package-actor', counts: { issue: 2, comment: 1 },
  fileCount: 1, expandedBytes: 9000, applySupported: false, errors: 1, warnings: 2,
  source: { product: 'jira', format: 'jira-json', instanceKey: 'never-emit-instance', declaredVersion: 'legacy', timezone: null },
};

const recordId = `${packageId}/issue:never-emit-source-id`;
const privateUrl = 'https://never-emit-jira.example.test/ticket/42';

function makePreview(overrides: Partial<MigrationPreview> = {}): MigrationPreview {
  return {
    id: previewId, version: 1, createdAt: '2026-11-20T00:00:00.000Z', expiresAt: '2026-11-20T00:30:00.000Z',
    actorId: 'never-emit-preview-actor', canApply: false,
    configuration: {
      packageIds: [packageId], projects: [{ containerId: 'never-emit-container', key: 'NEVER_EMIT_PROJECT', name: 'never-emit-name' }],
      users: { 'never-emit-unassigned@company.test': null, 'never-emit-user-name': 'never-emit-team-member' },
      statuses: {}, issueTypes: {}, fields: {}, timezone: 'Asia/Seoul', datePolicy: 'block',
      sourceBaseUrls: { [packageId]: privateUrl }, excludedRecords: [recordId],
    },
    projects: [{ id: 'never-emit-project-id', key: 'NEVER_EMIT_PROJECT', name: 'never-emit-name', issueCount: 2, documentCount: 0 }],
    samples: [{ recordId, targetType: 'issue', title: 'never-emit-title', plainText: 'never-emit-body', sourceUrl: privateUrl }],
    issueRefresh: [{ issueId: 'never-emit-issue-id', key: 'never-emit-key', sourceKey: 'never-emit-source-key',
      fields: [{ field: 'title', current: 'never-emit-current-title', incoming: 'never-emit-incoming-title', decision: 'conflict' }] }],
    counts: { sourceRecords: 4, issues: 1, explicitExcludedRecords: 1, excludedRecords: 2, excludedDescendants: 1,
      conflictingFields: 1, worklogs: -1, 'never-emit-unknown-count-key': 42 },
    notices: [
      { severity: 'warning', code: 'RECORDS_EXCLUDED', message: 'never-emit-exclusion', recordId, requiresAcknowledgement: true },
      { severity: 'error', code: 'RESTRICTED_CONTENT', message: 'never-emit-restriction', recordId, requiresAcknowledgement: false },
      { severity: 'warning', code: 'RECORDS_EXCLUDED', message: 'never-emit-second-exclusion', recordId: null, requiresAcknowledgement: true },
      { severity: 'info', code: 'never-emit-private-code', message: privateUrl, recordId, requiresAcknowledgement: false },
    ],
    requiredAcknowledgements: ['RECORDS_EXCLUDED', 'RECORDS_EXCLUDED'],
    ...overrides,
  };
}

test('migration preflight exports the selected package and counts without copying source details', () => {
  const preview = makePreview();
  const report = buildMigrationPreflightReport(preview, [{ ...jira, id: unrelatedPackageId }, jira]);
  assert.deepEqual(report, {
    format: 'teamspace-migration-preflight', version: 1,
    preview: { id: previewId, version: 1, createdAt: preview.createdAt, expiresAt: preview.expiresAt, canApply: false },
    mode: 'new', status: 'blocked',
    packages: [{ id: packageId, product: 'jira', format: 'jira-json', size: 4000, sha256: jira.sha256, errors: 1, warnings: 2 }],
    missingPackageSummaryCount: 0,
    counts: { sourceRecords: 4, explicitExcludedRecords: 1, excludedRecords: 2, excludedDescendants: 1, issues: 1, conflictingFields: 1 },
    diagnostics: [
      { severity: 'error', code: 'RESTRICTED_CONTENT', count: 1 },
      { severity: 'warning', code: 'RECORDS_EXCLUDED', count: 2 },
      { severity: 'info', code: 'UNRECOGNIZED_CODE', count: 1 },
    ],
    requiredAcknowledgements: ['RECORDS_EXCLUDED'],
    mapping: { users: { mapped: 1, unmapped: 1 }, explicitExclusions: 1 },
  });
  assert.doesNotMatch(JSON.stringify(report), /never-emit|NEVER_EMIT|\/private\/|company\.test/i);
});

test('migration preflight distinguishes planner warnings, acknowledgements and missing evidence from a ready plan', () => {
  const { configuration } = makePreview();
  const clean = makePreview({ canApply: true, notices: [], requiredAcknowledgements: [], counts: {},
    configuration: { ...configuration, excludedRecords: [], appendTo: { projectId: 'never-emit-project-id', statuses: {}, issueTypes: {}, fields: {} } } });
  const packageSummary = { ...jira, errors: 0 };
  const ready = buildMigrationPreflightReport(clean, [packageSummary]);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.mode, 'append');

  const warning = buildMigrationPreflightReport({ ...clean, notices: [{ severity: 'warning', code: 'FIELD_ARCHIVED', message: 'never-emit-field',
    recordId: null, requiresAcknowledgement: false }] }, [packageSummary]);
  assert.equal(warning.status, 'review');
  assert.deepEqual(warning.requiredAcknowledgements, []);

  const awaitingAcknowledgement = buildMigrationPreflightReport({ ...clean, requiredAcknowledgements: ['RECORDS_EXCLUDED'],
    configuration: { ...configuration, appendPagesTo: { projectId: 'never-emit-project-id' } } }, [packageSummary]);
  assert.equal(awaitingAcknowledgement.status, 'review');
  assert.equal(awaitingAcknowledgement.mode, 'append-pages');

  const missingSummary = buildMigrationPreflightReport(clean, []);
  assert.equal(missingSummary.status, 'review');
  assert.equal(missingSummary.missingPackageSummaryCount, 1);
});
