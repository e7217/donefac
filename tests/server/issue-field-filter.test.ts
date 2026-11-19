import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  CustomFieldDefinition,
  CustomFieldKind,
  CustomFieldValue,
  Issue,
  IssueFieldFilter,
  IssueFieldOperator,
  ProjectIssueSchema,
} from '../../shared/types.js';
import { defaultIssueSchema } from '../../shared/issue-schema.js';
import {
  createIssueFieldMatcher,
  fieldFilterOperators,
  IssueFieldFilterError,
  MAX_FIELD_FILTER_RULES,
  parseIssueFieldFilter,
} from '../../shared/issue-field-filter.js';

const users = [{ id: 'alice' }, { id: 'bob' }];
function field(id: string, kind: CustomFieldKind, extra: Partial<CustomFieldDefinition> = {}): CustomFieldDefinition {
  return {
    id, name: id, description: '', kind, required: false, issueTypes: [], archived: false,
    options: kind === 'select' || kind === 'multi_select' ? [
      { id: 'red', name: '빨강', archived: false }, { id: 'blue', name: '파랑', archived: true },
    ] : [],
    ...extra,
  };
}
function schema(): ProjectIssueSchema {
  return {
    ...defaultIssueSchema('p'),
    fields: [
      field('note', 'text'), field('risk', 'number'), field('when', 'date'),
      field('link', 'url'), field('checked', 'checkbox'), field('severity', 'select'),
      field('services', 'multi_select'), field('owner', 'user'),
      field('historical', 'text', { archived: true }), field('scoped', 'text', { issueTypes: ['incident'] }),
    ],
  };
}
function issue(customFields: Record<string, CustomFieldValue> = {}, extra: Partial<Issue> = {}): Issue {
  return {
    id: 'i', projectId: 'p', key: 'P-1', title: '필터 대상', description: '', type: 'incident',
    status: 'todo', priority: 'medium', assigneeId: null, collaboratorIds: [], parentId: null,
    labels: [], startDate: null, endDate: null, dueDate: null, estimate: null,
    cycle: null, module: null, release: null, version: 1, createdAt: '2026-11-19T00:00:00Z',
    updatedAt: '2026-11-19T00:00:00Z', completedAt: null, customFields, ...extra,
  };
}
const group = (fieldId: string, operator: IssueFieldOperator, value?: string | number | boolean): IssueFieldFilter => ({
  match: 'all', rules: [{ fieldId, operator, ...(value === undefined ? {} : { value }) }],
});
function matcher(fieldId: string, operator: IssueFieldOperator, value?: string | number | boolean) {
  const current = schema();
  return createIssueFieldMatcher(parseIssueFieldFilter(group(fieldId, operator, value), current, users), current);
}
const rejects = (value: unknown, current = schema()) => assert.throws(
  () => parseIssueFieldFilter(value, current, users),
  (error: unknown) => error instanceof IssueFieldFilterError && error.status === 400,
);

test('each field kind exposes only its supported immutable operators', () => {
  const presence = ['is_set', 'is_empty'];
  const expected: [CustomFieldKind, string[]][] = [
    ['text', [...presence, 'equals', 'not_equals', 'contains']],
    ['url', [...presence, 'equals', 'not_equals', 'contains']],
    ['number', [...presence, 'equals', 'not_equals', 'gte', 'lte']],
    ['date', [...presence, 'equals', 'not_equals', 'gte', 'lte']],
    ['checkbox', [...presence, 'equals', 'not_equals']],
    ['select', [...presence, 'equals', 'not_equals']],
    ['user', [...presence, 'equals', 'not_equals']],
    ['multi_select', [...presence, 'includes', 'excludes']],
  ];
  for (const [kind, operators] of expected) {
    assert.deepEqual(fieldFilterOperators(kind), operators);
    assert.ok(Object.isFrozen(fieldFilterOperators(kind)));
  }
  assert.deepEqual(fieldFilterOperators('constructor' as CustomFieldKind), []);
});

test('strict groups require one to eight rules, known keys and explicit all/any without inherited properties', () => {
  const valid = group('risk', 'equals', 0);
  for (const value of [
    undefined, null, [], true, 'all', {}, { rules: valid.rules }, { ...valid, match: 'none' },
    { ...valid, extra: true }, { match: 'all', rules: [] }, { match: 'all', rules: 'risk' },
    { match: 'all', rules: new Array(1) }, Object.create(valid),
    JSON.parse('{"match":"all","rules":[],"__proto__":{"polluted":true}}'),
    { match: 'all', rules: Array.from({ length: MAX_FIELD_FILTER_RULES + 1 }, () => valid.rules[0]) },
  ]) rejects(value);
  assert.equal(parseIssueFieldFilter({ match: 'any', rules: Array.from({ length: MAX_FIELD_FILTER_RULES }, () => valid.rules[0]) }, schema(), users).rules.length, 8);
  assert.deepEqual(parseIssueFieldFilter(Object.assign(Object.create(null), valid), schema(), users), valid);
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
});

test('rules reject unknown fields, unsupported operators, missing operands and meaningless presence operands', () => {
  for (const rule of [
    null, [], {}, { operator: 'is_set' }, { fieldId: 'risk' },
    { fieldId: 'missing', operator: 'is_set' }, { fieldId: '__proto__', operator: 'is_empty' },
    { fieldId: 'constructor', operator: 'is_set' }, { fieldId: 'risk', operator: 'contains', value: 1 },
    { fieldId: 'note', operator: 'gte', value: 'a' }, { fieldId: 'services', operator: 'equals', value: 'red' },
    { fieldId: 'risk', operator: 'equals' }, { fieldId: 'note', operator: 'is_set', value: null },
    { fieldId: 'checked', operator: 'is_empty', value: undefined },
    { fieldId: 'note', operator: 'contains', value: 'a', ignored: true },
    Object.create({ fieldId: 'note', operator: 'is_empty' }),
  ]) rejects({ match: 'all', rules: [rule] });
});

test('typed operands use strict values, real ISO dates, known option/member IDs and canonical finite numbers', () => {
  const invalid: [string, unknown][] = [
    ['risk', '0'], ['risk', NaN], ['risk', Infinity], ['risk', null],
    ['checked', 'false'], ['checked', 0], ['when', '2025-02-29'], ['when', '2026-1-01'],
    ['when', '2026-11-19T00:00:00Z'], ['when', ' 2026-11-19 '], ['severity', '빨강'],
    ['severity', 'missing'], ['severity', ['red']], ['owner', 'missing'], ['owner', ' alice '],
    ['note', ''], ['note', '   '], ['note', 1], ['note', 'a'.repeat(20001)],
    ['link', '/relative'], ['link', 'javascript:alert(1)'], ['link', 'https://user:pass@example.test'],
    ['link', `https://example.test/${'a'.repeat(4000)}`],
  ];
  for (const [fieldId, value] of invalid) rejects({ match: 'all', rules: [{ fieldId, operator: 'equals', value }] });
  rejects({ match: 'all', rules: [{ fieldId: 'services', operator: 'includes', value: ['red'] }] });
  for (const value of [0, -0, -1e100, 1e100, Number.MAX_VALUE]) {
    assert.equal(parseIssueFieldFilter(group('risk', 'equals', value), schema(), users).rules[0].value, value);
  }
  assert.equal(parseIssueFieldFilter(group('when', 'equals', '0000-01-01'), schema(), users).rules[0].value, '0000-01-01');
  assert.equal(parseIssueFieldFilter(group('when', 'equals', '2024-02-29'), schema(), users).rules[0].value, '2024-02-29');
  assert.equal(parseIssueFieldFilter(group('link', 'equals', ' https://EXAMPLE.test/path '), schema(), users).rules[0].value, 'https://EXAMPLE.test/path');
  assert.equal(parseIssueFieldFilter(group('link', 'contains', ' EXAMPLE '), schema(), users).rules[0].value, 'EXAMPLE');
});

test('text equals remains exact, contains is case insensitive, whitespace is preserved and URL matching uses stored text', () => {
  const value = issue({ note: '  Mixed CASE 한글  ', link: 'https://EXAMPLE.test/path?key=ABC' });
  assert.equal(matcher('note', 'equals', '  Mixed CASE 한글  ')(value), true);
  assert.equal(matcher('note', 'equals', 'Mixed CASE 한글')(value), false);
  assert.equal(matcher('note', 'equals', '  mixed case 한글  ')(value), false);
  assert.equal(matcher('note', 'contains', 'mixed case')(value), true);
  assert.equal(matcher('note', 'contains', '  mixed')(value), true);
  assert.equal(matcher('note', 'contains', 'mixed  ')(value), false);
  assert.equal(matcher('note', 'not_equals', 'different')(value), true);
  assert.equal(matcher('link', 'contains', 'example.TEST/path')(value), true);
  assert.equal(matcher('link', 'equals', ' https://EXAMPLE.test/path?key=ABC ')(value), true);
  assert.equal(matcher('link', 'equals', 'https://example.test/path?key=ABC')(value), false);
});

test('zero/false are present while missing, null, whitespace and empty selections never satisfy negative value operators', () => {
  const zero = issue({ risk: 0, checked: false });
  assert.equal(matcher('risk', 'is_set')(zero), true);
  assert.equal(matcher('risk', 'equals', 0)(zero), true);
  assert.equal(matcher('risk', 'is_empty')(zero), false);
  assert.equal(matcher('checked', 'is_set')(zero), true);
  assert.equal(matcher('checked', 'equals', false)(zero), true);
  assert.equal(matcher('checked', 'not_equals', true)(zero), true);
  for (const value of [undefined, null, '', '  ', []] as (CustomFieldValue | undefined)[]) {
    const empty = issue(value === undefined ? {} : { note: value, risk: value, checked: value, services: value });
    for (const id of ['note', 'risk', 'checked', 'services']) {
      assert.equal(matcher(id, 'is_empty')(empty), true, `${id}: ${JSON.stringify(value)}`);
      assert.equal(matcher(id, 'is_set')(empty), false, `${id}: ${JSON.stringify(value)}`);
    }
    assert.equal(matcher('note', 'not_equals', 'x')(empty), false);
    assert.equal(matcher('risk', 'not_equals', 1)(empty), false);
    assert.equal(matcher('checked', 'not_equals', true)(empty), false);
    assert.equal(matcher('services', 'excludes', 'red')(empty), false);
  }
});

test('number/date ranges compare typed values inclusively and malformed stored values fail closed', () => {
  const value = issue({ risk: -1.25, when: '2024-02-29' });
  assert.equal(matcher('risk', 'gte', -1.25)(value), true);
  assert.equal(matcher('risk', 'lte', -1.25)(value), true);
  assert.equal(matcher('risk', 'gte', 0)(value), false);
  assert.equal(matcher('when', 'gte', '2024-02-28')(value), true);
  assert.equal(matcher('when', 'lte', '2024-02-29')(value), true);
  assert.equal(matcher('when', 'not_equals', '2024-02-29')(value), false);
  assert.equal(matcher('when', 'gte', '2024-03-01')(value), false);
  assert.equal(matcher('risk', 'not_equals', 0)(issue({ risk: NaN })), false);
  assert.equal(matcher('risk', 'not_equals', 0)(issue({ risk: '1' })), false);
  assert.equal(matcher('when', 'not_equals', '2024-02-29')(issue({ when: '2024-02-30' })), false);
});

test('option/user IDs remain stable across renamed and archived fields/options; multi-value includes/excludes use one ID', () => {
  const current = schema();
  current.fields.find(item => item.id === 'severity')!.archived = true;
  const value = issue({ severity: 'blue', services: ['red', 'blue'], owner: 'alice', historical: '옛 값' });
  const input = group('severity', 'equals', 'blue');
  assert.equal(createIssueFieldMatcher(parseIssueFieldFilter(input, current, users), current)(value), true);
  current.fields.find(item => item.id === 'severity')!.name = '이름 변경';
  current.fields.find(item => item.id === 'severity')!.options[1].name = '파랑 이름 변경';
  assert.equal(createIssueFieldMatcher(input, current)(value), true);
  assert.equal(matcher('services', 'includes', 'blue')(value), true);
  assert.equal(matcher('services', 'excludes', 'blue')(value), false);
  assert.equal(matcher('services', 'excludes', 'blue')(issue({ services: ['red'] })), true);
  assert.equal(matcher('owner', 'equals', 'alice')(value), true);
  assert.equal(matcher('owner', 'not_equals', 'bob')(value), true);
  assert.equal(matcher('historical', 'equals', '옛 값')(value), true);
});

test('all/any groups honor per-type applicability including is_empty and reject cross-project or unknown-field groups', () => {
  const current = schema();
  const all: IssueFieldFilter = { match: 'all', rules: [{ fieldId: 'risk', operator: 'gte', value: 0 }, { fieldId: 'scoped', operator: 'is_empty' }] };
  const any: IssueFieldFilter = { ...all, match: 'any' };
  assert.equal(createIssueFieldMatcher(all, current)(issue({ risk: 0 })), true);
  assert.equal(createIssueFieldMatcher(all, current)(issue({ risk: 0 }, { type: 'request' })), false);
  assert.equal(createIssueFieldMatcher(any, current)(issue({ risk: 0 }, { type: 'request' })), true);
  assert.equal(matcher('scoped', 'is_empty')(issue({}, { type: 'request' })), false);
  assert.equal(matcher('scoped', 'is_set')(issue({ scoped: 'retained' }, { type: 'request' })), false);
  assert.equal(createIssueFieldMatcher(any, current)(issue({ risk: 0 }, { projectId: 'other' })), false);
  assert.equal(createIssueFieldMatcher(undefined, current)(issue({}, { projectId: 'other' })), true);
  const unknown: IssueFieldFilter = { match: 'any', rules: [{ fieldId: 'missing', operator: 'is_empty' }, { fieldId: 'risk', operator: 'equals', value: 0 }] };
  assert.equal(createIssueFieldMatcher(unknown, current)(issue({ risk: 0 })), false);
  assert.equal(createIssueFieldMatcher({ match: 'all', rules: [] }, current)(issue()), false);
});

test('prototype/accessor values cannot supply rules or custom-field matches and parsing leaves input/schema unchanged', () => {
  let getterCalls = 0;
  const withGetter = Object.defineProperty({ match: 'all' }, 'rules', { enumerable: true, get() { getterCalls++; return []; } });
  rejects(withGetter);
  const rules = [{ fieldId: 'risk', operator: 'equals', value: 0 }];
  Object.defineProperty(rules, '0', { get() { getterCalls++; return {}; } });
  rejects({ match: 'all', rules });
  assert.equal(getterCalls, 0);
  const inherited = Object.create({ risk: 0 }) as Record<string, CustomFieldValue>;
  assert.equal(matcher('risk', 'equals', 0)(issue(inherited)), false);
  const accessor = Object.defineProperty({}, 'risk', { get() { getterCalls++; return 0; } });
  assert.equal(matcher('risk', 'equals', 0)(issue(accessor)), false);
  assert.equal(matcher('risk', 'is_empty')(issue(accessor)), false);
  assert.equal(getterCalls, 0);
  const current = schema(), originalSchema = structuredClone(current), input = group('risk', 'equals', 0), original = structuredClone(input);
  const result = parseIssueFieldFilter(input, current, users);
  assert.deepEqual(input, original);
  assert.deepEqual(current, originalSchema);
  result.rules[0].value = 100;
  assert.equal(input.rules[0].value, 0);
});
