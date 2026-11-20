import type { LegacyPackageSummary, MigrationNotice, MigrationPreview } from './types.js';

const countKeys = [
  'sourceRecords', 'excludedRecords', 'explicitExcludedRecords', 'excludedDescendants', 'projects', 'issues', 'documents',
  'comments', 'revisions', 'attachments', 'attachmentVersions', 'fileCopies', 'attachmentBytes', 'resourceLinks',
  'issueRelations', 'atlassianLinks', 'unlinkedAtlassianRecords', 'worklogs', 'archivedWorklogs', 'retainedIssues',
  'retainedPages', 'retainedRecords', 'updatedIssues', 'updatedFields', 'conflictingFields', 'skippedIssueUpdates',
  'updatedCustomFields', 'conflictingCustomFields', 'updatedDocuments', 'updatedDocumentFields', 'conflictingDocumentFields',
  'skippedDocumentUpdates', 'newConfluenceAttachments', 'newConfluenceAttachmentVersions', 'reusedConfluenceAttachmentVersions',
  'newConfluenceComments', 'newConfluenceRevisions', 'newJiraAttachments', 'newJiraComments', 'newJiraWorklogs',
] as const;

const severityOrder: Record<MigrationNotice['severity'], number> = { error: 0, warning: 1, info: 2 };

function diagnosticCode(code: string): string {
  return /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'UNRECOGNIZED_CODE';
}

/** Build the shareable summary of one immutable migration preview from allowlisted fields. */
export function buildMigrationPreflightReport(preview: MigrationPreview, packages: readonly LegacyPackageSummary[]) {
  const { id, version, createdAt, expiresAt, canApply, configuration } = preview;
  const mode = configuration.appendTo ? 'append' : configuration.appendPagesTo ? 'append-pages' : 'new';
  const packagesById = new Map(packages.map(pkg => [pkg.id, pkg]));
  const selectedPackages = configuration.packageIds.flatMap(packageId => {
    const pkg = packagesById.get(packageId);
    if (!pkg) return [];
    const { id, source: { product, format }, size, sha256, errors, warnings } = pkg;
    return [{ id, product, format, size, sha256, errors, warnings }];
  });
  const missingPackageSummaryCount = configuration.packageIds.length - selectedPackages.length;

  const counts: Partial<Record<(typeof countKeys)[number], number>> = {};
  for (const key of countKeys) {
    const value = preview.counts[key];
    if (Number.isSafeInteger(value) && value >= 0) counts[key] = value;
  }

  const groups = new Map<string, { severity: MigrationNotice['severity']; code: string; count: number }>();
  for (const notice of preview.notices) {
    const { severity } = notice;
    const code = diagnosticCode(notice.code);
    const key = `${severity}:${code}`;
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { severity, code, count: 1 });
  }
  const diagnostics = [...groups.values()].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || a.code.localeCompare(b.code));
  const requiredAcknowledgements = [...new Set(preview.requiredAcknowledgements.map(diagnosticCode))].sort();
  const needsReview = missingPackageSummaryCount > 0 || requiredAcknowledgements.length > 0 ||
    diagnostics.some(entry => entry.severity === 'warning');
  const status = !canApply ? 'blocked' : needsReview ? 'review' : 'ready';

  const configuredUsers = Object.values(configuration.users);
  const mapped = configuredUsers.filter(value => typeof value === 'string' && value.length > 0).length;
  return {
    format: 'teamspace-migration-preflight' as const,
    version: 1 as const,
    preview: { id, version, createdAt, expiresAt, canApply },
    mode,
    status,
    packages: selectedPackages,
    missingPackageSummaryCount,
    counts,
    diagnostics,
    requiredAcknowledgements,
    mapping: { users: { mapped, unmapped: configuredUsers.length - mapped }, explicitExclusions: counts.explicitExcludedRecords ?? 0 },
  };
}
