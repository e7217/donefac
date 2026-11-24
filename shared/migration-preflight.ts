import { MIGRATION_AUTHOR_DISPOSITIONS, MIGRATION_AUTHOR_KINDS,
  type LegacyPackageSummary, type MigrationAuthorDisposition, type MigrationNotice, type MigrationPreview } from './types.js';

const countKeys = [
  'sourceRecords', 'excludedRecords', 'explicitExcludedRecords', 'excludedDescendants', 'projects', 'issues', 'documents',
  'comments', 'revisions', 'attachments', 'attachmentVersions', 'fileCopies', 'attachmentBytes', 'resourceLinks',
  'issueRelations', 'atlassianLinks', 'unlinkedAtlassianRecords', 'worklogs', 'archivedWorklogs', 'retainedIssues',
  'retainedPages', 'retainedRecords', 'updatedIssues', 'updatedFields', 'conflictingFields', 'skippedIssueUpdates',
  'updatedCustomFields', 'conflictingCustomFields', 'updatedDocuments', 'updatedDocumentFields', 'conflictingDocumentFields',
  'skippedDocumentUpdates', 'newConfluenceAttachments', 'newConfluenceAttachmentVersions', 'reusedConfluenceAttachmentVersions',
  'newConfluenceComments', 'newConfluenceRevisions', 'newJiraAttachments', 'newJiraComments', 'newJiraWorklogs',
  'updatedJiraWorklogs', 'confirmedJiraWorklogs', 'conflictingJiraWorklogs', 'archivedJiraWorklogCorrections',
  'newJiraRelations', 'skippedJiraRelations',
  'jiraReleases', 'jiraReleaseLinks', 'jiraReleaseUnassigned',
  'jiraSprints', 'jiraSprintLinks', 'jiraSprintUnassigned', 'jiraSprintHistoryOnly',
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
  const authorGroups = new Map(preview.authorAttribution?.map(group => [group.packageId, group.kinds]));
  const authorAttribution = selectedPackages.flatMap(({ id: packageId }) => {
    const group = authorGroups.get(packageId);
    if (!group) return [];
    const kinds = MIGRATION_AUTHOR_KINDS.flatMap(kind => {
      const item = group.find(item => item.kind === kind);
      if (!item) return [];
      const counts = Object.fromEntries(MIGRATION_AUTHOR_DISPOSITIONS.map(status => {
        const value = item.counts[status];
        return [status, Number.isSafeInteger(value) && value >= 0 ? value : 0];
      })) as Record<MigrationAuthorDisposition, number>;
      return Object.values(counts).some(value => value > 0) ? [{ kind, counts }] : [];
    });
    return kinds.length ? [{ packageId, kinds }] : [];
  });
  const needsReview = missingPackageSummaryCount > 0 || requiredAcknowledgements.length > 0 ||
    Boolean(counts.conflictingJiraWorklogs || counts.archivedJiraWorklogCorrections) ||
    diagnostics.some(entry => entry.severity === 'warning') || authorAttribution.some(({ kinds }) =>
      kinds.some(({ counts }) => counts['unmapped-fallback'] > 0 || counts['missing-fallback'] > 0));
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
    ...(authorAttribution.length ? { authorAttribution } : {}),
    mapping: { users: { mapped, unmapped: configuredUsers.length - mapped }, explicitExclusions: counts.explicitExcludedRecords ?? 0 },
  };
}
