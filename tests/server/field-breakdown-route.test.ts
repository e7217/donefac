import assert from 'node:assert/strict';
import test from 'node:test';
import { fieldBreakdownHash, fieldBreakdownParameters, readFieldBreakdownScope, sameFieldBreakdownScope } from '../../src/lib/field-breakdown-route.js';

test('a linked field report round-trips the project, both dimensions and the exact saved view', () => {
  const scope = { groupBy: 'status', comparisonBy: 'assignee', savedViewId: 'saved view+&=1' } as const;
  const hash = fieldBreakdownHash('project/a', scope);
  const [path, query] = hash.split('?');
  assert.equal(path, '#/project%2Fa/reports/fields');
  assert.deepEqual(readFieldBreakdownScope(new URLSearchParams(`${query}&issue=some-ticket`)), scope);
  assert.ok(sameFieldBreakdownScope(scope, readFieldBreakdownScope(fieldBreakdownParameters(scope))));
  assert.equal(fieldBreakdownHash('sample-project', {}), '#/sample-project/reports/fields');
  assert.equal(sameFieldBreakdownScope(null, {}), false);
  assert.deepEqual(readFieldBreakdownScope(new URLSearchParams('savedView=missing-view')), { savedViewId: 'missing-view' });
  assert.deepEqual(readFieldBreakdownScope(new URLSearchParams('fieldId=unavailable&savedView=foreign&comparisonBy=status')),
    { fieldId: 'unavailable', savedViewId: 'foreign', comparisonBy: 'status' });
});

test('a custom comparison round-trips its exact field and never aliases a built-in dimension', () => {
  const custom = { fieldId: 'planning', comparisonFieldId: 'risk flag+&=1', savedViewId: 'view' };
  assert.deepEqual(readFieldBreakdownScope(fieldBreakdownParameters(custom)), custom);
  const builtin = { groupBy: 'status', comparisonFieldId: 'status' } as const;
  assert.deepEqual(readFieldBreakdownScope(fieldBreakdownParameters(builtin)), builtin);
  assert.equal(sameFieldBreakdownScope(custom, { ...custom, comparisonFieldId: 'other' }), false);
});

test('an optional numeric measure round-trips and distinguishes exact custom field IDs from built-in measures', () => {
  const scope = { groupBy: 'status', comparisonBy: 'priority', measure: { kind: 'custom', fieldId: 'risk +&=1' } } as const;
  assert.equal(fieldBreakdownParameters(scope).get('measure'), 'custom:risk +&=1');
  assert.deepEqual(readFieldBreakdownScope(fieldBreakdownParameters(scope)), scope);
  assert.ok(sameFieldBreakdownScope(scope, readFieldBreakdownScope(fieldBreakdownParameters(scope))));
  const builtin = { groupBy: 'status', measure: { kind: 'estimate' } } as const;
  assert.deepEqual(readFieldBreakdownScope(fieldBreakdownParameters(builtin)), builtin);
  assert.equal(sameFieldBreakdownScope(builtin, { ...builtin, measure: { kind: 'custom', fieldId: 'estimate' } }), false);
  assert.equal(sameFieldBreakdownScope(builtin, { groupBy: 'status' }), false);
  assert.deepEqual(readFieldBreakdownScope(new URLSearchParams('fieldId=score&measure=plannedEffortMinutes')),
    { fieldId: 'score', measure: { kind: 'plannedEffortMinutes' } });
});

test('conflicting or malformed report links cannot become broader valid filters', () => {
  for (const query of [
    'groupBy=status&fieldId=score', 'groupBy=typo&savedView=expected-view', 'groupBy=&savedView=expected-view',
    'groupBy=status&comparisonBy=status', 'comparisonBy=type&savedView=expected-view', 'fieldId=score&comparisonBy=wrong',
    'fieldId=score&savedView=view-one&savedView=view-two', 'fieldId=score&savedView=%20', 'fieldId=%00score',
    'fieldId=score&comparisonFieldId=score', 'groupBy=status&comparisonBy=type&comparisonFieldId=score',
    'savedView=view&comparisonFieldId=score', 'fieldId=score&comparisonFieldId=%00bad',
    'groupBy=type&comparisonFieldId=score&comparisonFieldId=other',
    'savedView=view&measure=estimate', 'groupBy=status&measure=estimate&measure=plannedEffortMinutes',
    'groupBy=status&measure=__proto__', 'groupBy=status&measure=', 'groupBy=status&measure=custom:',
    'groupBy=status&measure=custom:%00bad', 'groupBy=status&measure=custom:%20padded',
    `fieldId=score&savedView=${'x'.repeat(201)}`,
  ]) {
    const parsed = readFieldBreakdownScope(new URLSearchParams(query));
    assert.deepEqual(parsed, { invalid: true }, query);
    assert.deepEqual(readFieldBreakdownScope(fieldBreakdownParameters(parsed)), parsed);
  }
});
