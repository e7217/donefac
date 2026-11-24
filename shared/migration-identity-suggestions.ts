import type { MigrationConfiguration, MigrationIdentityOption, MigrationOptions, User } from './types.js';

const localAtom = /^[\p{L}\p{M}\p{N}!#$%&'*+/=?^_`{|}~-]+$/u;
const domainLabel = /^[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}-]*[\p{L}\p{M}\p{N}])?$/u;

export function normalizeMigrationEmail(email: string | null | undefined): string | null {
  const address = email?.trim().toLowerCase();
  if (!address || address.length > 254 || /\p{Default_Ignorable_Code_Point}/u.test(address)) return null;
  const parts = address.split('@');
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  const labels = domain.split('.');
  return local.length <= 64 && local.split('.').every(atom => localAtom.test(atom)) &&
    labels.length >= 2 && labels.every(label => label.length <= 63 && domainLabel.test(label)) ? address : null;
}

type SourceAccount = { emails: Set<string>; mappedUsers: Set<string>; uncertain: boolean };

export function suggestMigrationIdentityMappings(
  options: Pick<MigrationOptions, 'identities' | 'packages'>,
  users: readonly User[],
  mappings: MigrationConfiguration['users'],
): { identityId: string; userId: string }[] {
  const teamByEmail = new Map<string, string | null>();
  for (const user of users) {
    const email = normalizeMigrationEmail(user.email);
    if (email) teamByEmail.set(email, teamByEmail.has(email) ? null : user.id);
  }

  const packageScopes = new Map(options.packages.map(({ id, source }) => [id, JSON.stringify([source.product, source.instanceKey])]));
  const accounts = new Map<string, SourceAccount>();
  const accountsByEmail = new Map<string, Set<string>>();
  const candidates: { identityId: string; userId: string; account: SourceAccount; emailKey: string }[] = [];
  for (const identity of options.identities) {
    const scope = packageScopes.get(identity.packageId);
    if (!scope) continue;
    const evidence = identity.emailEvidence;
    const accountKey = JSON.stringify([scope, evidence?.accountId ?? identity.sourceValue]);
    let account = accounts.get(accountKey);
    if (!account) {
      account = { emails: new Set(), mappedUsers: new Set(), uncertain: false };
      accounts.set(accountKey, account);
    }
    const mapped = Object.hasOwn(mappings, identity.id) ? mappings[identity.id] : null;
    if (mapped !== null) account.mappedUsers.add(mapped);

    const confirmed = normalizeMigrationEmail(evidence?.email);
    // Uncertain legacy claims can make an address ambiguous, but cannot establish a match.
    const email = confirmed ?? normalizeMigrationEmail(identity.email);
    if (!confirmed && (evidence !== undefined || email)) account.uncertain = true;
    if (!email) continue;
    account.emails.add(email);
    const emailKey = JSON.stringify([scope, email]);
    let claimants = accountsByEmail.get(emailKey);
    if (!claimants) {
      claimants = new Set();
      accountsByEmail.set(emailKey, claimants);
    }
    claimants.add(accountKey);
    const userId = confirmed ? teamByEmail.get(confirmed) : null;
    if (userId && mapped === null) candidates.push({ identityId: identity.id, userId, account, emailKey });
  }

  return candidates.filter(({ userId, account, emailKey }) => !account.uncertain && account.emails.size === 1 &&
    accountsByEmail.get(emailKey)?.size === 1 && (account.mappedUsers.size === 0 || (account.mappedUsers.size === 1 && account.mappedUsers.has(userId))))
    .map(({ identityId, userId }) => ({ identityId, userId }));
}

type AssignedSourceAccount = {
  emails: Set<string>;
  uncertainEmail: boolean;
  assignedUsers: Set<string>;
  assignmentByPackage: Map<string, string>;
};

export function suggestSameSourceAccountMappings(
  options: Pick<MigrationOptions, 'identities' | 'packages'>,
  users: readonly User[],
  mappings: MigrationConfiguration['users'],
): { identityId: string; userId: string; fromIdentityId: string }[] {
  const roster = new Set(users.map(user => user.id));
  const sources = new Map(options.packages.map(({ id, source }) => [id, source]));
  const accounts = new Map<string, AssignedSourceAccount>();
  const unmapped: { identity: MigrationIdentityOption; account: AssignedSourceAccount }[] = [];
  for (const identity of options.identities) {
    const source = sources.get(identity.packageId);
    const evidence = identity.accountEvidence;
    if (!source || !evidence || !evidence.key || evidence.key.trim() !== evidence.key) continue;
    const compatibleKind = source.product === 'jira' ? evidence.kind === 'jira-account-id' || evidence.kind === 'jira-user-key'
      : evidence.kind === 'confluence-user-key';
    if (!compatibleKind) continue;
    const accountKey = JSON.stringify([source.product, source.instanceKey, evidence.kind, evidence.key]);
    let account = accounts.get(accountKey);
    if (!account) {
      account = { emails: new Set(), uncertainEmail: false, assignedUsers: new Set(), assignmentByPackage: new Map() };
      accounts.set(accountKey, account);
    }
    const verifiedEmail = normalizeMigrationEmail(identity.emailEvidence?.email);
    const displayedEmail = normalizeMigrationEmail(identity.email);
    if (identity.emailEvidence === null || identity.emailEvidence !== undefined && !verifiedEmail) account.uncertainEmail = true;
    if (verifiedEmail) account.emails.add(verifiedEmail);
    if (displayedEmail) account.emails.add(displayedEmail);

    const mapped = Object.hasOwn(mappings, identity.id) ? mappings[identity.id] : null;
    if (mapped === null) unmapped.push({ identity, account });
    else {
      account.assignedUsers.add(mapped);
      if (!account.assignmentByPackage.has(identity.packageId)) account.assignmentByPackage.set(identity.packageId, identity.id);
    }
  }

  return unmapped.flatMap(({ identity, account }) => {
    if (account.uncertainEmail || account.emails.size > 1 || account.assignedUsers.size !== 1) return [];
    const userId = account.assignedUsers.values().next().value;
    if (!userId || !roster.has(userId)) return [];
    const from = [...account.assignmentByPackage].find(([packageId]) => packageId !== identity.packageId);
    return from ? [{ identityId: identity.id, userId, fromIdentityId: from[1] }] : [];
  });
}
