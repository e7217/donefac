import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Issue, Project, ReportingLedgerData } from '../../shared/types.js';
import { ReportingLedger, ReportingLedgerError, previousIssueKeys } from '../../server/reporting-ledger.js';
import { aggregateProjectReport } from '../../server/reporting-metrics.js';
import { Store } from '../../server/store.js';
import { WorkflowService } from '../../server/workflows.js';

const initial = '2026-11-19T00:00:00.000Z', tomorrow = '2026-11-20T00:00:00.000Z', restoredAt = '2026-11-21T00:00:00.000Z';
const invalid = (error: unknown) => error instanceof ReportingLedgerError && error.status === 400;
function issue(id: string, changes: Partial<Issue> = {}): Issue {
  return { id, projectId: 'p', key: `SYN-${id}`, title: `합성 업무 ${id}`, description: '', type: '작업', status: 'todo', priority: 'medium', assigneeId: null, collaboratorIds: [], parentId: null, labels: [], startDate: null, endDate: null, dueDate: null, estimate: null, cycle: null, module: null, release: null, version: 1, createdAt: '2020-01-01T00:00:00.000Z', updatedAt: initial, completedAt: null, ...changes };
}
function fixture(seed = true) {
  const dir = mkdtempSync(join(tmpdir(), 'teamspace-reporting-ledger-')), store = new Store(dir);
  const projects: Project[] = ['p', 'q'].map((id, index) => ({ id, key: `SYN${index}`, name: `합성 프로젝트 ${id}`, description: '', color: '#567899', createdAt: initial }));
  for (const project of projects) store.put('projects', project);
  store.put('users', { id: 'actor', name: '합성 작업자', email: 'actor@example.test', color: '#567899' });
  if (seed) store.put('issues', issue('existing'));
  const workflows = new WorkflowService(store);
  let clock = initial;
  const ledger = new ReportingLedger(store, id => workflows.get(id), () => clock);
  ledger.start();
  return { dir, store, workflows, ledger, projects, setClock: (value: string) => { clock = value; }, close() { ledger.close(); store.db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function copy<T>(value: T): T { return structuredClone(value); }

test('collection begins with observed baselines and records real creates, relevant changes and deleted source snapshots', () => {
  const f = fixture();
  try {
    const baseline = f.ledger.read('p');
    assert.equal(baseline.coverage.length, 1); assert.equal(baseline.coverage[0].reason, 'initial');
    assert.equal(baseline.events.length, 1); assert.equal(baseline.events[0].kind, 'baseline');
    assert.equal(baseline.events[0].occurredAt, initial); assert.equal(baseline.events[0].before, null); assert.equal(baseline.events[0].origin, 'system');
    assert.notEqual(baseline.events[0].occurredAt, issue('existing').createdAt);
    f.store.withMutationContext({ actorId: 'actor', origin: 'user' }, () => {
      f.store.put('issues', issue('new'));
      f.store.put('issues', issue('new', { status: 'in_progress', assigneeId: 'actor', startDate: '2026-11-19', version: 2 }));
      f.store.put('issues', issue('new', { status: 'in_progress', assigneeId: 'actor', startDate: '2026-11-19', description: '본문만 변경', completedAt: tomorrow, version: 3, updatedAt: tomorrow }));
      f.store.remove('issues', 'new');
    });
    const events = f.ledger.read('p').events;
    assert.deepEqual(events.map(event => event.kind), ['baseline', 'created', 'changed', 'deleted']);
    assert.deepEqual(events.map(event => event.sequence), [1, 2, 3, 4]);
    assert.ok(events.slice(1).every(event => event.actorId === 'actor' && event.origin === 'user' && event.workflowVersion === 1));
    assert.equal(events[2].before?.statusId, 'todo'); assert.equal(events[2].after?.category, 'in_progress');
    assert.equal(events[3].before?.assigneeId, 'actor'); assert.equal(events[3].after, null);
    assert.deepEqual(f.ledger.current('p').map(state => state.issueId), ['existing']);
    f.store.put('issues', issue('other', { projectId: 'q' }));
    assert.equal(f.ledger.read('p').events.length, 4); assert.equal(f.ledger.read('q').events.length, 1);
    assert.throws(() => f.ledger.current(''), invalid); assert.throws(() => f.ledger.read('missing'), (error: unknown) => error instanceof ReportingLedgerError && error.status === 404);
  } finally { f.close(); }
});

test('transaction failures roll back source mutation, sequence and every ledger row, including hook validation errors', () => {
  const f = fixture();
  try {
    const before = f.ledger.read('p');
    assert.throws(() => f.store.transaction(() => {
      f.store.put('issues', issue('existing', { status: 'in_progress' }));
      f.store.put('issues', issue('transient'));
      throw new Error('합성 감사 저장 실패');
    }), /감사 저장 실패/);
    assert.deepEqual(f.ledger.read('p'), before); assert.equal(f.store.get<Issue>('issues', 'existing')?.status, 'todo'); assert.equal(f.store.get('issues', 'transient'), undefined);
    assert.throws(() => f.store.put('issues', issue('bad', { status: 'unknown' })), invalid);
    assert.equal(f.store.get('issues', 'bad'), undefined); assert.deepEqual(f.ledger.read('p'), before);
    f.store.put('issues', issue('valid'));
    assert.equal(f.ledger.read('p').events.at(-1)?.sequence, 2);
  } finally { f.close(); }
});

test('project transfer observes both memberships and reserves the previous key without reporting a creation, completion or deletion', () => {
  const f = fixture();
  try {
    const workflow = f.workflows.get('p');
    f.workflows.save('p', { ...workflow, statuses: [...workflow.statuses, { id: 'local_intake', label: '원래 프로젝트 접수', category: 'review', color: '#5065aa' }] }, workflow.version);
    const before = issue('existing', { status: 'local_intake', key: 'SYN0-3', version: 2 });
    f.store.put('issues', before);
    f.setClock(tomorrow);
    f.store.withMutationContext({ actorId: 'actor', origin: 'user' }, () => {
      f.store.put('issues', { ...before, projectId: 'q', key: 'SYN1-7', status: 'done', version: 3, updatedAt: tomorrow, completedAt: tomorrow });
    });
    const archived = f.ledger.exportData(restoredAt);
    const [out, into] = archived.events.slice(-2);
    assert.equal(out.kind, 'moved_out');
    assert.deepEqual(out.before, { ...out.before!, projectId: 'p', key: 'SYN0-3', statusId: 'local_intake', statusLabel: '원래 프로젝트 접수', category: 'review' });
    assert.equal(into.kind, 'moved_in');
    assert.equal(into.projectId, 'q');
    assert.equal(into.after?.key, 'SYN1-7');
    assert.equal(into.after?.category, 'done');
    assert.equal(into.sequence, out.sequence + 1);
    assert.deepEqual(previousIssueKeys(f.store).get(before.id), [{ projectId: 'p', key: 'SYN0-3' }]);
    assert.deepEqual(f.ledger.validateRestore(archived, restoredAt, restoredAt, f.projects), archived);
    const unpaired = copy(archived); unpaired.events.pop();
    assert.throws(() => f.ledger.validateRestore(unpaired, restoredAt, restoredAt, f.projects), invalid);
    const wrongActor = copy(archived); wrongActor.events.at(-1)!.actorId = 'another';
    assert.throws(() => f.ledger.validateRestore(wrongActor, restoredAt, restoredAt, f.projects), invalid);

    const report = (projectId: string) => aggregateProjectReport({ projectId, startDate: '2026-11-20', endDate: '2026-11-20', timeZone: 'UTC', issueType: null, assigneeId: null },
      { current: f.ledger.current(projectId), ledger: f.ledger.read(projectId), generatedAt: restoredAt });
    const source = report('p'), target = report('q');
    for (const view of [source, target]) {
      assert.equal(view.period.deleted, 0);
      assert.equal(view.period.created, 0);
      assert.equal(view.period.completionTransitions, 0);
    }
    assert.equal(source.issues.find(row => row.issue.issueId === before.id)?.movedOut, true);
    assert.equal(source.issues.find(row => row.issue.issueId === before.id)?.deleted, false);
    assert.equal(source.current.total, 0);
    assert.equal(target.current.state.done, 1);
  } finally { f.close(); }
});

test('workflow category and label changes retain their contemporaneous meaning without duplicate issue-update events', () => {
  const f = fixture();
  try {
    const first = f.workflows.get('p');
    f.workflows.save('p', { ...first, statuses: first.statuses.map(status => status.id === 'todo' ? { ...status, category: 'done', label: '수집 후 완료 분류' } : status) }, first.version);
    let events = f.ledger.read('p').events;
    assert.equal(events.length, 2); assert.equal(events[1].kind, 'reclassified'); assert.equal(events[1].workflowVersion, 2);
    assert.equal(events[0].after?.category, 'todo'); assert.equal(events[1].before?.category, 'todo'); assert.equal(events[1].after?.category, 'done');
    assert.ok(f.store.get<Issue>('issues', 'existing')?.completedAt);
    const second = f.workflows.get('p');
    f.workflows.save('p', { ...second, statuses: second.statuses.map(status => status.id === 'todo' ? { ...status, category: 'cancelled', label: '취소 분류' } : status) }, second.version);
    const third = f.workflows.get('p');
    f.workflows.save('p', { ...third, statuses: third.statuses.map(status => status.id === 'todo' ? { ...status, label: '취소 이름 변경' } : status) }, third.version);
    events = f.ledger.read('p').events;
    assert.equal(events.length, 4); assert.deepEqual(events.map(event => event.after?.category), ['todo', 'done', 'cancelled', 'cancelled']);
    assert.equal(events[3].before?.statusLabel, '취소 분류'); assert.equal(events[3].after?.statusLabel, '취소 이름 변경');
    assert.equal(f.ledger.current('p')[0].statusLabel, '취소 이름 변경');
    const exported = f.ledger.exportData(tomorrow);
    assert.deepEqual(f.ledger.validateRestore(exported, tomorrow, restoredAt, f.projects), exported);
  } finally { f.close(); }
});

test('restart keeps coverage and baseline stable, and clock regression cannot reverse committed event order', () => {
  const f = fixture();
  try {
    f.setClock(tomorrow); f.store.put('issues', issue('existing', { status: 'in_progress' }));
    f.setClock('2000-01-01T00:00:00.000Z'); f.store.put('issues', issue('existing', { status: 'review' }));
    const before = f.ledger.read('p');
    assert.deepEqual(before.events.map(event => event.occurredAt), [initial, tomorrow, tomorrow]);
    f.ledger.close(); f.store.db.close();
    const store = new Store(f.dir), workflows = new WorkflowService(store), ledger = new ReportingLedger(store, id => workflows.get(id), () => initial);
    try {
      ledger.start(); ledger.start();
      assert.deepEqual(ledger.read('p'), before);
      store.put('issues', issue('existing', { status: 'done' }));
      assert.equal(ledger.read('p').events.at(-1)?.occurredAt, tomorrow); assert.equal(ledger.read('p').events.at(-1)?.sequence, 4);
      ledger.close(); store.put('issues', issue('existing', { title: '구독 해제 뒤' }));
      assert.equal(ledger.read('p').events.length, 4);
    } finally { ledger.close(); store.db.close(); }
  } finally { f.ledger.close(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('export does not close live collection; native restoration preserves deleted histories and starts an explicit new coverage baseline', () => {
  const f = fixture();
  try {
    f.store.withMutationContext({ actorId: 'historical-actor-no-current-user', origin: 'automation' }, () => f.store.remove('issues', 'existing'));
    const exported = f.ledger.exportData(tomorrow);
    assert.equal(exported.coverage[0].endedAt, tomorrow); assert.equal(f.ledger.read('p').coverage[0].endedAt, null);
    const historical = copy(exported); historical.events[0].after!.assigneeId = 'historical-assignee'; historical.events[1].before!.assigneeId = 'historical-assignee';
    const validated = f.ledger.validateRestore(historical, tomorrow, restoredAt, f.projects);
    assert.equal(validated.events[1].issueId, 'existing'); assert.equal(validated.events[1].after, null);
    const before = f.ledger.read('p');
    assert.throws(() => f.store.transaction(() => { f.ledger.replaceRestored(validated, restoredAt); throw new Error('복원 커밋 실패'); }), /커밋 실패/);
    assert.deepEqual(f.ledger.read('p'), before);
    f.setClock(restoredAt);
    f.store.withMutationContext({ actorId: null, origin: 'import' }, () => f.store.transaction(() => {
      f.store.put('issues', issue('restored', { createdAt: initial }));
      f.ledger.replaceRestored(validated, restoredAt);
    }));
    const result = f.ledger.read('p');
    assert.deepEqual(result.coverage.map(value => [value.startedAt, value.endedAt, value.reason]), [[initial, tomorrow, 'initial'], [restoredAt, null, 'restore']]);
    assert.equal(result.events.length, 3); assert.equal(result.events[2].kind, 'baseline'); assert.equal(result.events[2].origin, 'import'); assert.equal(result.events[2].occurredAt, restoredAt); assert.equal(result.events[2].issueId, 'restored');
    f.store.put('issues', issue('restored', { status: 'in_progress' }));
    assert.equal(f.ledger.read('p').events.at(-1)?.kind, 'changed');
    const roundtrip = f.ledger.exportData(restoredAt);
    assert.deepEqual(f.ledger.validateRestore(roundtrip, restoredAt, restoredAt, f.projects), roundtrip);
    f.store.transaction(() => f.ledger.replaceRestored(roundtrip, restoredAt));
    assert.deepEqual(f.ledger.read('p').coverage.map(value => value.endedAt), [tomorrow, restoredAt, null]);
    const sameInstant = f.ledger.exportData(restoredAt);
    assert.deepEqual(f.ledger.validateRestore(sameInstant, restoredAt, restoredAt, f.projects), sameInstant);
  } finally { f.close(); }
});

test('restore validation rejects malformed chronology, identities, shapes and discontinuous states without touching persisted data', () => {
  const f = fixture();
  try {
    f.store.put('issues', issue('existing', { status: 'in_progress' }));
    const valid = f.ledger.exportData(tomorrow), before = f.ledger.read('p');
    const cases: ((data: ReportingLedgerData) => void)[] = [
      data => { data.coverage[0].endedAt = null; },
      data => { data.coverage[0].startedAt = '2026-11-19T00:00:00Z'; },
      data => { data.coverage.push({ ...data.coverage[0], id: 'overlap' }); },
      data => { data.events[1].id = data.events[0].id; },
      data => { data.events[1].sequence = data.events[0].sequence; },
      data => { data.events[1].sequence = 0; },
      data => { data.events.reverse(); },
      data => { data.events[1].occurredAt = '2026-11-18T00:00:00.000Z'; },
      data => { data.events[1].occurredAt = restoredAt; },
      data => { data.events[1].projectId = 'missing'; },
      data => { data.events[1].coverageId = 'missing'; },
      data => { data.events[1].before!.issueId = 'different'; },
      data => { data.events[1].before!.statusId = 'review'; },
      data => { data.events[1].after!.dueDate = '2026-02-30'; },
      data => { data.events[1].after = null; },
      data => { data.events[1].kind = 'reclassified'; },
      data => { data.events[1].kind = 'baseline'; data.events[1].before = null; },
      data => { data.events[0].workflowVersion = -1; },
    ];
    for (const change of cases) { const corrupted = copy(valid); change(corrupted); assert.throws(() => f.ledger.validateRestore(corrupted, tomorrow, restoredAt, f.projects), invalid); }
    assert.throws(() => f.ledger.validateRestore(valid, tomorrow, initial, f.projects), invalid);
    assert.throws(() => f.ledger.exportData('2020-01-01T00:00:00.000Z'), invalid);
    assert.deepEqual(f.ledger.read('p'), before); assert.deepEqual(f.ledger.validateRestore(valid, tomorrow, restoredAt, f.projects), valid);
  } finally { f.close(); }
});

test('migration creates only explicit import baselines at observation time and rolls them back with canonical writes', () => {
  const f = fixture(false);
  try {
    f.store.withMutationContext({ actorId: 'actor', origin: 'import' }, () => f.store.transaction(() => f.store.put('issues', issue('source', { status: 'done' }))));
    assert.equal(f.ledger.read('p').events.length, 0);
    f.store.transaction(() => f.ledger.baselineImportedIssues([issue('source', { status: 'done' })]));
    const events = f.ledger.read('p').events;
    assert.equal(events.length, 1); assert.equal(events[0].kind, 'baseline'); assert.equal(events[0].occurredAt, initial); assert.equal(events[0].origin, 'import');
    f.store.transaction(() => f.ledger.baselineImportedIssues([issue('source', { status: 'done' })]));
    assert.equal(f.ledger.read('p').events.length, 1);
    assert.throws(() => f.store.transaction(() => f.ledger.baselineImportedIssues([issue('source', { status: 'todo' })])), invalid);
    assert.throws(() => f.store.withMutationContext({ actorId: null, origin: 'import' }, () => f.store.transaction(() => {
      f.store.put('issues', issue('rolled-back'));
      f.ledger.baselineImportedIssues([issue('rolled-back')]);
      throw new Error('첨부 커밋 실패');
    })), /첨부 커밋 실패/);
    assert.equal(f.store.get('issues', 'rolled-back'), undefined); assert.deepEqual(f.ledger.read('p').events, events);
    f.store.put('issues', issue('source', { status: 'review' }));
    assert.equal(f.ledger.read('p').events.at(-1)?.before?.category, 'done');
  } finally { f.close(); }
});

test('upgrading an active legacy ledger adds cycle membership and estimates at the first observation without changing weekly history', () => {
  const f = fixture();
  try {
    const weekly = f.ledger.read('p');
    f.ledger.close();
    // Persist the projection written by the older collector while retaining its live coverage.
    f.store.db.prepare('UPDATE reporting_coverage SET json=? WHERE id=?')
      .run(JSON.stringify(weekly.coverage[0]), weekly.coverage[0].id);
    f.store.db.prepare('UPDATE reporting_events SET json=? WHERE id=?')
      .run(JSON.stringify(weekly.events[0]), weekly.events[0].id);
    const existing = issue('existing', { cycleId: 'cycle-a', estimate: 2.5 });
    f.store.put('issues', existing);
    f.setClock(tomorrow);
    f.ledger.start();
    assert.deepEqual(f.ledger.read('p'), weekly);
    const beforeMove = f.ledger.readCycle('p', 'cycle-a');
    assert.deepEqual(beforeMove.coverage, [{ ...weekly.coverage[0], cycleStartedAt: tomorrow }]);
    assert.equal(beforeMove.events.length, 1);
    const [observed] = beforeMove.events;
    assert.equal(observed.kind, 'cycle_baseline');
    assert.equal(observed.sequence, 2);
    assert.equal(observed.occurredAt, tomorrow);
    assert.deepEqual(observed.before, weekly.events[0].after);
    assert.deepEqual(observed.after, { ...weekly.events[0].after, cycleId: 'cycle-a', estimate: 2.5 });
    assert.deepEqual(f.ledger.readCycle('p', 'cycle-a', initial).events, []);

    f.ledger.close();
    f.ledger.start();
    assert.deepEqual(f.ledger.readCycle('p', 'cycle-a'), beforeMove);
    f.store.put('issues', { ...existing, cycleId: 'cycle-b', estimate: 0, version: 2 });
    assert.deepEqual(f.ledger.read('p'), weekly);
    const outgoing = f.ledger.readCycle('p', 'cycle-a').events.at(-1);
    const incoming = f.ledger.readCycle('p', 'cycle-b').events.at(-1);
    assert.equal(outgoing?.before?.cycleId, 'cycle-a');
    assert.equal(incoming?.after?.cycleId, 'cycle-b');
    assert.equal(incoming?.after?.estimate, 0);
    assert.deepEqual(incoming, outgoing);
    assert.deepEqual(f.ledger.readCycle('q', 'cycle-b').events, []);

    const exported = f.ledger.exportData(tomorrow);
    const validated = f.ledger.validateRestore(exported, tomorrow, restoredAt, f.projects);
    assert.deepEqual(validated, exported);
    const corruptions: ((data: ReportingLedgerData) => void)[] = [
      data => { delete data.coverage[0].cycleStartedAt; },
      data => { data.coverage[0].cycleStartedAt = restoredAt; },
      data => { data.events[1].origin = 'user'; },
      data => { data.events[1].after!.estimate = -1; },
      data => { delete data.events[1].after!.cycleId; },
      data => { data.events[1].after!.title = '원래 관측 이후를 바꿀 수 없음'; },
      data => { data.events[2].before!.estimate = 1; },
      data => { data.events.splice(1); },
    ];
    for (const corrupt of corruptions) {
      const modified = copy(exported);
      corrupt(modified);
      assert.throws(() => f.ledger.validateRestore(modified, tomorrow, restoredAt, f.projects), invalid);
    }
    f.store.transaction(() => f.ledger.replaceRestored(validated, restoredAt));
    const restored = f.ledger.readCycle('p', 'cycle-b');
    assert.deepEqual(restored.coverage.map(epoch => [epoch.startedAt, epoch.cycleStartedAt, epoch.endedAt]), [
      [initial, tomorrow, tomorrow], [restoredAt, restoredAt, null],
    ]);
    assert.deepEqual(restored.events.map(event => [event.kind, event.after?.cycleId, event.after?.estimate]), [
      ['changed', 'cycle-b', 0], ['baseline', 'cycle-b', 0],
    ]);
  } finally { f.close(); }
});
