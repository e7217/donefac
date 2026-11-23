import assert from 'node:assert/strict';
import test from 'node:test';
import { buildJiraComponentOptions } from '../../server/migration-jira-component-options.js';

test('Jira component choices deduplicate IDs and use scope for equivalent names', () => {
  const candidates = [
    { id: 'o_core', name: '  런타임  ', scope: 'CORE' },
    { id: 'o_core', name: '이전 런타임', scope: 'CORE' },
    { id: 'o_core', name: '', scope: 'CORE' },
    { id: 'o_apps', name: '런타임', scope: 'APPS' },
    { id: 'o_api', name: 'API', scope: 'CORE' },
  ];
  const expected = [
    { id: 'o_api', name: 'API', archived: false },
    { id: 'o_apps', name: '런타임 · APPS', archived: false },
    { id: 'o_core', name: '런타임 · CORE', archived: false },
  ];
  assert.deepEqual(buildJiraComponentOptions(candidates), expected);
  assert.deepEqual(buildJiraComponentOptions([...candidates].reverse()), expected);
});

test('Jira component choice suffixes leave literal labels intact and use IDs for same-scope collisions', () => {
  const candidates = [
    { id: 'o_alpha', name: 'Runtime', scope: 'CORE' },
    { id: 'o_beta', name: 'Runtime', scope: 'CORE' },
    { id: 'o_ops', name: 'Runtime', scope: 'OPS' },
    { id: 'o_scope_name', name: 'Runtime · CORE', scope: 'EXTRA' },
    { id: 'o_id_name', name: 'Runtime · CORE · o_alpha', scope: 'EXTRA' },
    { id: 'o_index_name', name: 'Runtime · CORE · o_alpha (2)', scope: 'EXTRA' },
  ];
  const options = buildJiraComponentOptions(candidates);
  const names = Object.fromEntries(options.map(option => [option.id, option.name]));
  assert.deepEqual(names, {
    o_alpha: 'Runtime · CORE · o_alpha (3)', o_beta: 'Runtime · CORE · o_beta', o_ops: 'Runtime · OPS',
    o_scope_name: 'Runtime · CORE', o_id_name: 'Runtime · CORE · o_alpha', o_index_name: 'Runtime · CORE · o_alpha (2)',
  });
  assert.deepEqual(buildJiraComponentOptions([...candidates].reverse()), options);
});

test('Jira component choices fit native name length without splitting supplementary characters or dropping IDs', () => {
  const name = `A${'😀'.repeat(100)}`;
  const scope = `P${'🧭'.repeat(100)}`;
  const candidates = [
    { id: 'o_long_a', name, scope },
    { id: 'o_long_b', name: `${name} other`, scope },
    { id: 'o_long_c', name: `B${name}`, scope },
    ...Array.from({ length: 205 }, (_, index) => ({ id: `o_generated_${index}`, name: `Component ${index}`, scope: 'CORE' })),
  ];
  const options = buildJiraComponentOptions(candidates);
  assert.equal(options.length, candidates.length);
  assert.equal(new Set(options.map(option => option.name)).size, options.length);
  assert.ok(options.every(option => option.name.length <= 120 && option.name.isWellFormed()));
  for (const id of ['o_long_a', 'o_long_b']) assert.ok(options.find(option => option.id === id)?.name.endsWith(id));
  assert.deepEqual(buildJiraComponentOptions([...candidates].reverse()), options);
});
