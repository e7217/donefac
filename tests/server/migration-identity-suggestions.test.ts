import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMigrationEmail, suggestMigrationIdentityMappings, suggestSameSourceAccountMappings } from '../../shared/migration-identity-suggestions.js';
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

function withAccount(row: MigrationIdentityOption, kind: NonNullable<MigrationIdentityOption['accountEvidence']>['kind'],
  key = row.sourceValue): MigrationIdentityOption {
  return { ...row, accountEvidence: { kind, key } };
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

test('suggests a previously assigned exact source account from the first other package in input order', () => {
  const first = sourcePackage('first', 'jira', 'eng');
  const second = sourcePackage('second', 'jira', 'eng');
  const third = sourcePackage('third', 'jira', 'eng');
  const key = 'owner-identity';
  const original = withAccount(identity(first.id, 'first-201', null), 'jira-account-id', key);
  const source = withAccount(identity(second.id, 'second-201', ' OWNER@EXAMPLE.TEST '), 'jira-account-id', key);
  const samePackage = withAccount(identity(first.id, 'first-copy', 'owner@example.test'), 'jira-account-id', key);
  const thirdPackage = withAccount(identity(third.id, 'third-copy', null), 'jira-account-id', key);
  const roster = [teamUser('owner', 'renamed@example.test')];
  const mappings = { [original.id]: 'owner', [source.id]: 'owner', [thirdPackage.id]: null };
  const options = { identities: [samePackage, original, thirdPackage, source], packages: [third, second, first] };

  assert.deepEqual(suggestSameSourceAccountMappings(options, roster, mappings), [
    { identityId: samePackage.id, userId: 'owner', fromIdentityId: source.id },
    { identityId: thirdPackage.id, userId: 'owner', fromIdentityId: original.id },
  ]);
  assert.deepEqual(mappings, { [original.id]: 'owner', [source.id]: 'owner', [thirdPackage.id]: null });
});

test('does not share assignments across products, instances, ID namespaces, case, or unproven rows', () => {
  const jira = sourcePackage('jira-first', 'jira', 'eng');
  const nextJira = sourcePackage('jira-next', 'jira', 'eng');
  const outside = sourcePackage('outside', 'jira', 'Eng');
  const wiki = sourcePackage('wiki-first', 'confluence', 'eng');
  const nextWiki = sourcePackage('wiki-next', 'confluence', 'eng');
  const from = withAccount(identity(jira.id, '001', null), 'jira-user-key');
  const wikiFrom = withAccount(identity(wiki.id, '001', null), 'confluence-user-key');
  const wikiNext = withAccount(identity(nextWiki.id, '001', null), 'confluence-user-key');
  const rows = [
    from, wikiFrom, wikiNext,
    withAccount(identity(nextJira.id, 'different-namespace', null), 'jira-account-id', '001'),
    withAccount(identity(wiki.id, 'unrelated-product', null), 'jira-user-key', '001'),
    withAccount(identity(nextJira.id, 'changed-key', null), 'jira-user-key', 'ABC'),
    withAccount(identity(jira.id, 'case-source', null), 'jira-user-key', 'abc'),
    withAccount(identity(outside.id, '001', null), 'jira-user-key'),
    withAccount(identity(jira.id, 'same-package', null), 'jira-user-key', '001'),
    withAccount(identity('unselected', '001', null), 'jira-user-key'),
    identity(nextJira.id, '001', 'owner@example.test'),
  ];
  assert.deepEqual(suggestSameSourceAccountMappings({ identities: rows, packages: [jira, nextJira, outside, wiki, nextWiki] },
    [teamUser('owner', 'owner@example.test')], { [from.id]: 'owner', [wikiFrom.id]: 'owner', [`${jira.id}/case-source`]: 'owner' }), [
    { identityId: wikiNext.id, userId: 'owner', fromIdentityId: wikiFrom.id },
  ]);
});

test('withholds the whole source account when assignments, email claims, or the live roster conflict', () => {
  const one = sourcePackage('one', 'jira', 'eng');
  const two = sourcePackage('two', 'jira', 'eng');
  const three = sourcePackage('three', 'jira', 'eng');
  const base = withAccount(identity(one.id, 'assigned', 'one@example.test'), 'jira-account-id', '001');
  const copy = withAccount(identity(two.id, 'copy', null), 'jira-account-id', '001');
  const third = withAccount(identity(three.id, 'third', null), 'jira-account-id', '001');
  const packages = [one, two, three];
  const roster = [teamUser('owner', 'owner@example.test'), teamUser('other', 'other@example.test')];
  const assignments = { [base.id]: 'owner' };
  const options = { identities: [base, copy, third], packages };
  assert.equal(suggestSameSourceAccountMappings(options, roster, assignments).length, 2);
  assert.deepEqual(suggestSameSourceAccountMappings(options, roster, { ...assignments, [third.id]: 'other' }), []);
  assert.deepEqual(suggestSameSourceAccountMappings(options, roster.slice(1), assignments), []);
  assert.deepEqual(suggestSameSourceAccountMappings(options, roster, {}), []);
  assert.deepEqual(suggestSameSourceAccountMappings({ ...options, identities: [base, copy, { ...third, emailEvidence: null }] }, roster, assignments), []);
  assert.deepEqual(suggestSameSourceAccountMappings({ ...options, identities: [base, copy, { ...third, email: 'two@example.test' }] }, roster, assignments), []);
});
