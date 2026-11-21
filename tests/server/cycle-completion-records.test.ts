import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { CycleCompletionRecord, Issue, PlanningItem, Project } from '../../shared/types.js';
import { CycleCompletionRecords, CycleCompletionRecordsError } from '../../server/cycle-completion-records.js';
import { Store } from '../../server/store.js';

const completedAt = '2026-11-20T09:30:00.000Z';
const exportedAt = '2026-11-21T00:00:00.000Z';
const team: Project = { id: 'team', key: 'TEAM', name: '팀', color: '#8899aa', description: '', createdAt: completedAt };
const other = { ...team, id: 'other', key: 'OTHER' };

function snapshot(values: Partial<CycleCompletionRecord> = {}): CycleCompletionRecord {
  return {
    id: 'saved', projectId: team.id,
    cycle: { id: 'source', name: '완료 당시 사이클', version: 3, startDate: '2026-11-16', endDate: '2026-11-19', targetDate: null },
    destination: { id: 'destination', name: '삭제한 사이클', version: 2 },
    actorId: 'former-user', actorName: '저장한\n담당자', completedAt,
    counts: { carry: 1, done: 1, cancelled: 0 },
    issues: [
      { id: 'live', key: '임시 키', title: '당시 제목\n두 번째 줄', statusId: 'todo', statusLabel: '진행 대기', disposition: 'carry',
        assigneeId: 'former-assignee', assigneeName: '당시\n담당자' },
      { id: 'deleted', key: 'TEAM-47', title: '삭제한 업무', statusId: 'done', statusLabel: '완료', disposition: 'done',
        assigneeId: null, assigneeName: null },
    ],
    ...values,
  };
}

function fixture(t: TestContext) {
  const path = mkdtempSync(join(tmpdir(), 'teamspace-cycle-records-'));
  const store = new Store(path);
  t.after(() => { store.db.close(); rmSync(path, { recursive: true, force: true }); });
  store.put('projects', team);
  store.put('projects', other);
  return { store, records: new CycleCompletionRecords(store) };
}

test('cycle completion backup preserves frozen history after live names, states and capture resources change', t => {
  const { records } = fixture(t);
  const saved = snapshot();
  const liveSource: PlanningItem = {
    ...saved.cycle, projectId: team.id, kind: 'cycle', name: '다시 열린 사이클', version: 9, status: 'active',
    description: '', ownerId: null, createdAt: completedAt, updatedAt: exportedAt,
  };
  const liveIssue = { id: 'live', projectId: team.id, key: '임시 키', title: '현재 제목', status: 'done' } as Issue;
  const options = { schemaVersion: 80, exportedAt, projects: [team, other], planningItems: [liveSource], issues: [liveIssue] };
  assert.deepEqual(records.validateRestore([saved], options), [saved]);
  assert.deepEqual(records.validateRestore([saved], { ...options, planningItems: [], issues: [] }), [saved]);
  assert.deepEqual(records.validateRestore(undefined, { ...options, schemaVersion: 79 }), []);
  assert.deepEqual(records.validateRestore([], { ...options, schemaVersion: 79 }), []);
  assert.throws(() => records.validateRestore([saved], { ...options, schemaVersion: 79 }), /schemaVersion 80/u);
  assert.throws(() => records.validateRestore(undefined, options), CycleCompletionRecordsError);

  const failures: unknown[] = [
    [{ ...saved, unrelated: true }],
    [{ ...saved, completedAt: '2026-11-22T00:00:00.000Z' }],
    [{ ...saved, counts: { ...saved.counts, carry: 2 } }],
    [{ ...saved, cycle: { ...saved.cycle, startDate: '2026-11-20' } }],
    [{ ...saved, destination: { id: saved.cycle.id, name: saved.cycle.name, version: 1 } }],
    [{ ...saved, issues: [saved.issues[0], { ...saved.issues[0], key: '다른 키' }] }],
    [saved, { ...saved, id: 'same-generation' }],
  ];
  for (const recordsInput of failures) assert.throws(() => records.validateRestore(recordsInput, options), CycleCompletionRecordsError);
  assert.throws(() => records.validateRestore([saved], { ...options, planningItems: [{ ...liveSource, version: 2 }] }), CycleCompletionRecordsError);
  assert.throws(() => records.validateRestore([saved], { ...options, planningItems: [{ ...liveSource, projectId: other.id }] }), CycleCompletionRecordsError);
  assert.throws(() => records.validateRestore([saved], { ...options, issues: [{ ...liveIssue, key: 'OTHER-5' }] }), CycleCompletionRecordsError);
});

test('cycle completion store pages immutable summary rows and restores detail inside a transaction', t => {
  const { store, records } = fixture(t);
  const first = snapshot();
  const second = snapshot({ id: 'next', cycle: { ...first.cycle, version: 7 } });
  const separate = snapshot({ id: 'separate', cycle: { ...first.cycle, id: 'different-cycle' } });
  const otherProject = snapshot({ id: 'external', projectId: other.id, cycle: { ...first.cycle, id: 'external-cycle' } });
  assert.throws(() => records.insert(first), CycleCompletionRecordsError);
  store.transaction(() => {
    for (const saved of [first, second, separate, otherProject]) records.insert(saved);
  });

  assert.deepEqual(records.get(team.id, first.id), first);
  assert.equal(records.get(other.id, first.id), undefined);
  const page = records.list(team.id, { cycleId: first.cycle.id, limit: 1 });
  assert.deepEqual(page.items.map(item => item.id), [second.id]);
  assert.equal(Object.hasOwn(page.items[0], 'issues'), false);
  assert.equal(page.nextCursor, second.id);
  const rest = records.list(team.id, { cycleId: first.cycle.id, cursor: page.nextCursor!, limit: 1 });
  assert.deepEqual(rest.items.map(item => item.id), [first.id]);
  assert.equal(rest.nextCursor, null);
  assert.throws(() => records.list(team.id, { cursor: otherProject.id, limit: 1 }), CycleCompletionRecordsError);
  assert.throws(() => records.list(team.id, { cycleId: first.cycle.id, cursor: separate.id, limit: 1 }), CycleCompletionRecordsError);
  assert.throws(() => store.transaction(() => records.insert(snapshot({ id: 'conflict' }))));
  const exported = records.exportRecords();
  assert.deepEqual(new Set(exported.map(item => item.id)), new Set([first.id, second.id, separate.id, otherProject.id]));
  assert.throws(() => store.transaction(() => { records.restore([second]); throw new Error('중단'); }), /중단/u);
  assert.deepEqual(records.exportRecords(), exported);
  store.transaction(() => records.restore([first]));
  assert.deepEqual(records.exportRecords(), [first]);
});
