import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearGanttDateDrafts,
  GANTT_DATE_DRAFT_PREFIX,
  ganttDateDraftKey,
  readGanttDateDrafts,
  writeGanttDateDrafts,
  type StoredGanttDateDraft,
} from '../../src/features/gantt-date-draft-storage.js';

const draft: StoredGanttDateDraft = {
  id: 'issue-a', projectId: 'project-a', version: 3,
  startDate: '2028-02-23', endDate: '2028-02-25', draftStart: '2028-02-29', draftEnd: '2028-02-25',
};

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key: index => Array.from(values.keys())[index] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
    clear: () => values.clear(),
  };
}

test('Gantt draft storage keeps typed dates, explicit clears and incomplete ranges without extra issue fields', () => {
  const storage = memoryStorage();
  const key = ganttDateDraftKey('actor-a', draft.projectId, undefined);
  assert.deepEqual(readGanttDateDrafts(storage, key), new Map());
  const draftWithIssueData = { ...draft, title: 'Unrelated issue data' };
  const clearingDraft = { ...draft, id: 'issue-b', draftStart: null, draftEnd: null };
  writeGanttDateDrafts(storage, key, new Map<string, StoredGanttDateDraft>([
    [draft.id, draftWithIssueData],
    [clearingDraft.id, clearingDraft],
  ]));
  assert.deepEqual(JSON.parse(storage.getItem(key)!), { schemaVersion: 1, drafts: [draft, clearingDraft] });
  assert.deepEqual(readGanttDateDrafts(storage, key), new Map([[draft.id, draft], [clearingDraft.id, clearingDraft]]));
  writeGanttDateDrafts(storage, key, new Map());
  assert.equal(storage.getItem(key), null);
});

test('Gantt draft storage filters malformed rows while rejecting an unreadable envelope', () => {
  const storage = memoryStorage();
  const key = ganttDateDraftKey('actor-a', null, 'generation-a');
  storage.setItem(key, JSON.stringify({ schemaVersion: 1, drafts: [
    { ...draft, id: 'non-leap-day', draftStart: '2027-02-29' },
    { ...draft, id: 'missing-date', draftEnd: undefined },
    { ...draft, id: 'missing-project', projectId: '' },
    { ...draft, id: 'zero-version', version: 0 },
    { ...draft, id: 'large-version', version: Number.MAX_SAFE_INTEGER + 1 },
    { ...draft, title: 'Ignore unrelated values' },
    { ...draft, draftEnd: '2028-03-01' },
    false,
  ] }));
  assert.deepEqual(readGanttDateDrafts(storage, key), new Map([[draft.id, draft]]));
  for (const invalid of ['{', 'null', '[]', '{"schemaVersion":2,"drafts":[]}', '{"schemaVersion":1,"drafts":{}}']) {
    storage.setItem(key, invalid);
    assert.throws(() => readGanttDateDrafts(storage, key));
    assert.equal(storage.getItem(key), invalid);
  }
});

test('Gantt draft storage namespaces scopes, actors and restore generations and clears only its own keys', () => {
  const storage = memoryStorage();
  const keys = [
    ganttDateDraftKey('actor-a', null, undefined),
    ganttDateDraftKey('actor-a', 'null', undefined),
    ganttDateDraftKey('actor-b', null, undefined),
    ganttDateDraftKey('actor-a', null, 'generation-a'),
    ganttDateDraftKey('actor-a', null, 'generation-b'),
  ];
  assert.equal(new Set(keys).size, keys.length);
  for (const key of keys) {
    assert.ok(key.startsWith(GANTT_DATE_DRAFT_PREFIX));
    writeGanttDateDrafts(storage, key, new Map([[draft.id, draft]]));
  }
  storage.setItem('donefac:actor', 'actor-a');
  clearGanttDateDrafts(storage);
  assert.equal(storage.length, 1);
  assert.equal(storage.getItem('donefac:actor'), 'actor-a');
});
