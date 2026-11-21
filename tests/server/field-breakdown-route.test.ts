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

test('conflicting or malformed report links cannot become broader valid filters', () => {
  for (const query of [
    'groupBy=status&fieldId=score', 'groupBy=typo&savedView=expected-view', 'groupBy=&savedView=expected-view',
    'groupBy=status&comparisonBy=status', 'comparisonBy=type&savedView=expected-view', 'fieldId=score&comparisonBy=wrong',
    'fieldId=score&savedView=view-one&savedView=view-two', 'fieldId=score&savedView=%20', 'fieldId=%00score',
    `fieldId=score&savedView=${'x'.repeat(201)}`,
  ]) {
    const parsed = readFieldBreakdownScope(new URLSearchParams(query));
    assert.deepEqual(parsed, { invalid: true }, query);
    assert.deepEqual(readFieldBreakdownScope(fieldBreakdownParameters(parsed)), parsed);
  }
});
