import { normalizeMigrationEmail } from '../shared/migration-identity-suggestions.js';
import type { LegacyRecord, MigrationIdentityOption } from '../shared/types.js';

const jiraIdentityEmailEvidenceKey = 'jiraIdentityEmailEvidence';

// Undefined represents no claim. A malformed or conflicting claim stays inconclusive.
function observedIdentityEmail(values: Iterable<unknown>): string | null | undefined {
  let known: string | undefined;
  for (const value of values) {
    if (value == null || (typeof value === 'string' && !value.trim())) continue;
    const email = typeof value === 'string' ? normalizeMigrationEmail(value) : null;
    if (!email || (known && known !== email)) return null;
    known = email;
  }
  return known;
}

export function observeJiraIdentityEmail(identity: LegacyRecord, values: Iterable<unknown>) {
  const observation = observedIdentityEmail(values);
  if (observation === undefined) return;

  const previous = identity.metadata[jiraIdentityEmailEvidenceKey];
  identity.metadata[jiraIdentityEmailEvidenceKey] = previous === undefined || previous === observation ? observation : null;
}

export function jiraIdentityEmailEvidence(identity: LegacyRecord | undefined): MigrationIdentityOption['emailEvidence'] {
  if (!identity) return;
  const { metadata } = identity;
  const recorded = metadata[jiraIdentityEmailEvidenceKey];
  if (recorded === null) return null;
  if (typeof recorded === 'string') {
    const email = normalizeMigrationEmail(recorded);
    return email ? { email } : null;
  }
  // Older staged records do not preserve conflicting observations for the same account.
  if (observedIdentityEmail([metadata.emailAddress, metadata.email]) !== undefined) return null;
}

export function confluenceIdentityEmailEvidence(records: ReadonlyMap<string, LegacyRecord>) {
  const proofs = new Map<string, MigrationIdentityOption['emailEvidence']>();
  const groups = new Map<string, LegacyRecord[]>();
  for (const row of records.values()) {
    if (row.kind !== 'identity') continue;
    if (row.metadata.sourceClass === 'ConfluenceUserImpl') {
      const group = groups.get(row.sourceId) ?? [];
      group.push(row);
      groups.set(row.sourceId, group);
      continue;
    }

    if (row.metadata.sourceClass === 'UserInfo') {
      const links = row.references.filter(ref => ref.kind === 'identity' && ref.relation === 'profile-user');
      const accountId = links.length === 1 ? links[0].sourceId : null;
      if (accountId && records.get(`identity:${accountId}`)?.metadata.sourceClass === 'ConfluenceUserImpl') {
        const group = groups.get(accountId) ?? [];
        group.push(row);
        groups.set(accountId, group);
        continue;
      }
    }

    if (observedIdentityEmail([row.metadata.emailAddress, row.metadata.email]) !== undefined) proofs.set(row.sourceId, null);
  }

  for (const [accountId, group] of groups) {
    const email = observedIdentityEmail(group.flatMap(row => [row.metadata.emailAddress, row.metadata.email]));
    if (email === undefined) continue;
    const evidence = email === null ? null : { email, accountId };
    for (const identity of group) proofs.set(identity.sourceId, evidence);
  }
  return proofs;
}
