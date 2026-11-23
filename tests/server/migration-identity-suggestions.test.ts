import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMigrationEmail, suggestMigrationIdentityMappings } from '../../shared/migration-identity-suggestions.js';
import type { LegacyPackageSummary, LegacySource, MigrationIdentityOption, User } from '../../shared/types.js';

function sourcePackage(id: string, product: LegacySource['product'], instanceKey: string): LegacyPackageSummary {
  return {
    id, filename: `${id}.zip`, sha256: '0'.repeat(64), size: 40, version: 1, createdAt: '2026-11-23T00:00:00Z',
    actorId: 'initiator', source: { product, format: product === 'jira' ? 'jira-json' : 'confluence-xml', instanceKey,
      declaredVersion: null, timezone: null }, counts: {}, errors: 0, warnings: 0, fileCount: 1, expandedBytes: 20,
    applySupported: false,
  };
}

function identity(packageId: string, sourceValue: string, email: string | null,
  evidence: MigrationIdentityOption['emailEvidence'] = email ? { email } : undefined): MigrationIdentityOption {
  return { id: `${packageId}/${sourceValue}`, packageId, sourceValue, label: '같은 이름', email, emailEvidence: evidence };
}

function teamUser(id: string, email: string): User {
  return { id, email, name: '같은 이름', color: '#236456' };
}

test('uses exact normalized addresses with explicit evidence, keeping existing user selections', () => {
  const jira = sourcePackage('tickets', 'jira', 'eng');
  const docs = sourcePackage('pages', 'confluence', 'eng');
  const users = [teamUser('first', ' 담당자@EXAMPLE.TEST '), teamUser('second', 'another@example.test')];
  const items = [identity(jira.id, 'confirmed', ' 담당자@EXAMPLE.TEST '),
    identity(docs.id, 'confirmed', '담당자@example.test'),
    identity(jira.id, 'manual', 'another@example.test'),
    identity(jira.id, 'incomplete', null),
    identity(jira.id, 'address-by-name', null),
    identity('missing-package', 'unknown', 'another@example.test')];
  const mappings = { [items[0].id]: null, [items[2].id]: 'first' };
  assert.deepEqual(suggestMigrationIdentityMappings({ identities: items, packages: [jira, docs] }, users, mappings), [
    { identityId: items[0].id, userId: 'first' }, { identityId: items[1].id, userId: 'first' },
  ]);
  assert.deepEqual(mappings, { [items[0].id]: null, [items[2].id]: 'first' });
});

test('skips ambiguous addresses in one source instance or among the current team, independently of other instances', () => {
  const jira = sourcePackage('tickets', 'jira', 'eng');
  const newerJira = sourcePackage('tickets-new', 'jira', 'eng');
  const otherJira = sourcePackage('tickets-external', 'jira', 'other');
  const items = [identity(jira.id, 'duplicate-one', 'staff@example.test'),
    identity(newerJira.id, 'duplicate-two', ' STAFF@example.test '),
    identity(otherJira.id, 'duplicate-one', 'staff@example.test'),
    identity(jira.id, 'ambiguous-team', 'duplicate@example.test')];
  const users = [teamUser('one', 'staff@example.test'), teamUser('duplicate-a', 'duplicate@example.test'),
    teamUser('duplicate-b', ' DUPLICATE@EXAMPLE.TEST ')];
  assert.deepEqual(suggestMigrationIdentityMappings({ identities: items, packages: [jira, newerJira, otherJira] }, users,
    { [items[0].id]: 'one' }), [{ identityId: items[2].id, userId: 'one' }]);
});

test('withholds competing uncertain raw claims and conflicting addresses or saved users for the same source account', () => {
  const previous = sourcePackage('pages-original', 'confluence', 'eng');
  const latest = sourcePackage('pages-new', 'confluence', 'eng');
  const users = [teamUser('one', 'one@example.test'), teamUser('two', 'two@example.test'), teamUser('three', 'three@example.test')];
  const uncertainClaim = identity(previous.id, 'other-user', 'ONE@example.test', null);
  const confirmed = identity(latest.id, 'confirmed', 'one@example.test');
  const changedBefore = identity(previous.id, 'changed-account', 'two@example.test');
  const changedAfter = identity(latest.id, 'changed-account', 'three@example.test');
  const legacy = identity(previous.id, 'legacy', 'three@example.test', null);
  assert.deepEqual(suggestMigrationIdentityMappings({ identities: [uncertainClaim, confirmed, changedBefore, changedAfter, legacy],
    packages: [previous, latest] }, users, {}), []);

  const alias = identity(previous.id, 'legacy-name', 'one@example.test', { email: 'one@example.test', accountId: 'confirmed' });
  const options = { identities: [confirmed, alias], packages: [previous, latest] };
  assert.deepEqual(suggestMigrationIdentityMappings(options, users, {}), [
    { identityId: confirmed.id, userId: 'one' }, { identityId: alias.id, userId: 'one' },
  ]);
  assert.deepEqual(suggestMigrationIdentityMappings(options, users, { [alias.id]: 'two' }), []);
  assert.deepEqual(suggestMigrationIdentityMappings(options, users, { [alias.id]: 'one' }), [
    { identityId: confirmed.id, userId: 'one' },
  ]);

  const uncertainAccount = identity(previous.id, 'confirmed', 'one@example.test', null);
  assert.deepEqual(suggestMigrationIdentityMappings({ ...options, identities: [confirmed, uncertainAccount] }, users, {}), []);
  const missingClaim = identity(previous.id, 'confirmed', null);
  assert.deepEqual(suggestMigrationIdentityMappings({ ...options, identities: [confirmed, missingClaim] }, users, {}), [
    { identityId: confirmed.id, userId: 'one' },
  ]);
});

test('validates plain addresses and keeps punctuation, Unicode and domain spellings exact', () => {
  assert.equal(normalizeMigrationEmail(' Jo.Smith+Team@Example.Test '), 'jo.smith+team@example.test');
  assert.equal(normalizeMigrationEmail('사용자@서울.example'), '사용자@서울.example');
  for (const value of [null, undefined, '', 'name', 'Display <one@example.test>', 'mailto:one@example.test',
    'one..two@example.test', 'one@example..test', 'one@-example.test', 'one@example.test.', 'one@example',
    'one @example.test', 'one\u200B@example.test', 'name@example.test, next@example.test', '"one"@example.test']) {
    assert.equal(normalizeMigrationEmail(value), null, String(value));
  }
  const pkg = sourcePackage('tickets', 'jira', 'eng');
  const items = ['Jo.Smith+Team@Example.Test', 'josmith@example.test', 'jo.smith@example.test'].map((email, index) =>
    identity(pkg.id, String(index), email));
  assert.deepEqual(suggestMigrationIdentityMappings({ identities: items, packages: [pkg] }, [teamUser('one', 'jo.smith@example.test')], {}), [
    { identityId: items[2].id, userId: 'one' },
  ]);
});
