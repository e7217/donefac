import type { MigrationConfiguration, MigrationOptions, User } from './types.js';

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
