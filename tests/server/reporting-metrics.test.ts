import assert from 'node:assert/strict';
import test from 'node:test';
import type { IssueReportEvent, ReportIssueState, ReportQuery, ReportingCoverage, ReportingLedgerData, StatusCategory } from '../../shared/types.js';
import { aggregateProjectReport, parseReportQuery, ReportingMetricsError } from '../../server/reporting-metrics.js';
const state = (issueId: string, category: StatusCategory, fields: Partial<ReportIssueState> = {}): ReportIssueState => ({
  issueId, projectId: 'p', key: `P-${issueId}`, title: issueId, type: 'task', statusId: category, statusLabel: category, category, assigneeId: 'alice', startDate: null, endDate: null, dueDate: null, ...fields
});
const epoch = (id = 'e', startedAt = '2026-11-01T00:00:00Z', endedAt: string | null = null): ReportingCoverage => ({
  id, startedAt, endedAt, reason: id === 'e' ? 'initial' : 'restore'
});
function events() {
  let sequence = 0;
  return (occurredAt: string, kind: IssueReportEvent['kind'], before: ReportIssueState | null, after: ReportIssueState | null, coverageId = 'e'): IssueReportEvent => ({
    id: `event-${++sequence}`, sequence, coverageId, projectId: (after || before)!.projectId, issueId: (after || before)!.issueId, occurredAt, kind, actorId: 'actor', origin: 'user', workflowVersion: 1, before, after
  });
}
const query = (fields: Partial<ReportQuery> = {}): ReportQuery => ({
  projectId: 'p', startDate: '2026-11-02', endDate: '2026-11-03', timeZone: 'UTC', issueType: null, assigneeId: null, ...fields
});
const report = (ledger: ReportingLedgerData, current: ReportIssueState[] = [], q = query(), generatedAt = '2026-11-04T12:00:00Z') => aggregateProjectReport(q, {
  ledger, current, generatedAt
});
const error = (status = 400) => (value: unknown) => value instanceof ReportingMetricsError && value.status === status;
test('query parsing requires strict dates, inclusive max92 days, real IANA zones and scalar selectors without normalization', () => {
  assert.deepEqual(parseReportQuery({
    projectId: 'p', startDate: '2024-01-01', endDate: '2024-04-01', timeZone: 'Asia/Seoul', issueType: '', assigneeId: null
  }), {
    projectId: 'p', startDate: '2024-01-01', endDate: '2024-04-01', timeZone: 'Asia/Seoul', issueType: null, assigneeId: null
  });
  for (const fields of [{ startDate: '2024-02-30' }, { endDate: '2026-11-01' }, { startDate: '2024-01-01', endDate: '2024-04-02' }, { timeZone: '+09:00' }, { timeZone: 'not/a-zone' }, { timeZone: ' Asia/Seoul' }, { startDate: '2026-11-2' }, { assigneeId: ['alice', 'bob'] }, { issueType: ' ' }, { unknown: 'field' }])
    assert.throws(() => parseReportQuery({ ...query(), ...fields }), error());
});
test('IANA boundaries use actual DST day lengths, skipped midnight and skipped date instead of fixed UTC24h', () => {
  for (const [timeZone, date, startAt, endAt, hours] of [
    ['America/New_York', '2024-03-10', '2024-03-10T05:00:00.000Z', '2024-03-11T04:00:00.000Z', 23],
    ['America/New_York', '2024-11-03', '2024-11-03T04:00:00.000Z', '2024-11-04T05:00:00.000Z', 25],
    ['America/Sao_Paulo', '2018-11-04', '2018-11-04T03:00:00.000Z', '2018-11-05T02:00:00.000Z', 23],
    ['Pacific/Apia', '2011-12-30', '2011-12-30T10:00:00.000Z', '2011-12-30T10:00:00.000Z', 0],
    ['Asia/Seoul', '2026-11-02', '2026-11-01T15:00:00.000Z', '2026-11-02T15:00:00.000Z', 24],
  ] as const) {
    const value = report({ coverage: [], events: [] }, [], query({
      timeZone, startDate: date, endDate: date
    }));
    assert.equal(value.rangeStartAt, startAt);
    assert.equal(value.rangeEndAt, endAt);
    assert.equal((Date.parse(value.rangeEndAt) - Date.parse(value.rangeStartAt)) / 3600000, hours);
    assert.equal(value.days[0].state, null);
  }
  const yearZero = report({ coverage: [], events: [] }, [], query({ startDate: '0000-01-01', endDate: '0000-01-01' }));
  assert.equal(yearZero.rangeStartAt, '0000-01-01T00:00:00.000Z');
  const localZero = report({ coverage: [], events: [] }, [], query({
    startDate: '0000-01-01', endDate: '0000-01-01', timeZone: 'Asia/Seoul'
  }));
  assert.equal(localZero.rangeStartAt, '-000001-12-31T15:32:08.000Z');
  const lastYear = report({ coverage: [], events: [] }, [], query({
    startDate: '9999-12-31', endDate: '9999-12-31', timeZone: 'America/New_York'
  }));
  assert.equal(lastYear.rangeEndAt, '+010000-01-01T05:00:00.000Z');
  assert.deepEqual(lastYear.coverage, []);
});
test('actual completion/reopen transitions use observed work entry outside the period, preserve fractional hours and count repeated completions', () => {
  const event = events(), todo = state('a', 'todo'), active = state('a', 'in_progress'), done = state('a', 'done', { title: '그때 완료 제목' }), baselineActive = state('c', 'in_progress'), baselineDone = state('b', 'done');
  const ledger = { coverage: [epoch()], events: [event('2026-11-01T00:00:00Z', 'baseline', null, todo), event('2026-11-01T00:00:00Z', 'baseline', null, baselineActive), event('2026-11-01T01:00:00Z', 'created', null, baselineDone), event('2026-11-01T08:00:00Z', 'changed', todo, active), event('2026-11-02T10:30:15.500Z', 'changed', active, done), event('2026-11-02T11:00:00Z', 'changed', done, todo), event('2026-11-02T11:30:00Z', 'changed', todo, active), event('2026-11-02T13:00:00Z', 'changed', active, done), event('2026-11-02T14:00:00Z', 'changed', baselineActive, state('c', 'done'))] };
  const value = report(ledger, [state('a', 'done', { title: '지금 바뀐 제목' }), baselineDone, state('c', 'done')]), first = (Date.parse('2026-11-02T10:30:15.500Z') - Date.parse('2026-11-01T08:00:00Z')) / 3600000;
  assert.equal(value.period.created, 0);
  assert.equal(value.period.completionTransitions, 3);
  assert.equal(value.period.completedIssues, 2);
  assert.equal(value.period.repeatedCompletions, 1);
  assert.equal(value.period.reopened, 1);
  assert.equal(value.period.cycleSamples, 2);
  assert.equal(value.period.medianCycleHours, (first + 1.5) / 2);
  assert.equal(value.issues.find(row => row.issue.issueId === 'a')!.cycleHours, 1.5);
  assert.equal(value.issues.find(row => row.issue.issueId === 'a')!.issue.title, '그때 완료 제목');
  assert.equal(value.issues.find(row => row.issue.issueId === 'c')!.cycleHours, null);
  assert.equal(value.days[0].completed, 3);
  assert.deepEqual(value.days.map(day => day.coverage), ['complete', 'complete']);
  assert.equal(value.days[0].state?.done, 3);
});
test('baseline imported work and created-done do not manufacture created/completed or cycle samples; semantic reclassification stays separate', () => {
  const event = events(), todo = state('a', 'todo'), active = state('a', 'in_progress'), done = state('a', 'done'), createdDone = state('b', 'done');
  const value = report({ coverage: [epoch()], events: [event('2026-11-02T00:00:00Z', 'baseline', null, todo), event('2026-11-02T01:00:00Z', 'changed', todo, active), event('2026-11-02T02:00:00Z', 'reclassified', active, done), event('2026-11-02T03:00:00Z', 'created', null, createdDone)] }, [done, createdDone]);
  assert.equal(value.period.created, 1);
  assert.equal(value.period.completionTransitions, 0);
  assert.equal(value.period.reclassified, 1);
  assert.equal(value.period.reopened, 0);
  assert.equal(value.period.cycleSamples, 0);
  assert.equal(value.days[0].state?.done, 2);
});
test('closed/restored gaps have null unknown day-close snapshots and never carry a cycle start through a new epoch', () => {
  const event = events(), todo = state('a', 'todo'), active = state('a', 'in_progress'), done = state('a', 'done');
  const coverage = [epoch('e', '2026-11-01T00:00:00Z', '2026-11-02T12:00:00Z'), epoch('restored', '2026-11-03T12:00:00Z')];
  const value = report({ coverage, events: [event('2026-11-01T00:00:00Z', 'baseline', null, todo), event('2026-11-02T08:00:00Z', 'changed', todo, active), event('2026-11-03T12:00:00Z', 'baseline', null, active, 'restored'), event('2026-11-03T13:00:00Z', 'changed', active, done, 'restored')] }, [done]);
  assert.deepEqual(value.days.map(day => day.coverage), ['partial', 'partial']);
  assert.equal(value.days[0].state, null);
  assert.equal(value.days[1].state?.done, 1);
  assert.equal(value.period.completionTransitions, 1);
  assert.equal(value.period.cycleSamples, 0);
  const separate = report({ coverage: [epoch('e', '2026-11-02T00:00:00Z', '2026-11-02T12:00:00Z'), epoch('restored', '2026-11-02T12:00:00Z')], events: [] }, [], query({ endDate: '2026-11-02' }));
  assert.equal(separate.days[0].coverage, 'partial');
  assert.equal(separate.days[0].state?.todo, 0);
});
test('historical type/assignee/title and deletion-before state determine period filters without injecting current metadata', () => {
  const event = events(), before = state('a', 'in_progress'), doneA = state('a', 'done', { title: 'Alice 완료 당시' }), reassigned = state('a', 'done', {
    assigneeId: 'bob', type: 'bug', title: '현재 Bob 제목'
  }), deleted = state('gone', 'todo', { title: '삭제 직전 제목' });
  const ledger = { coverage: [epoch()], events: [event('2026-11-01T00:00:00Z', 'baseline', null, before), event('2026-11-02T08:00:00Z', 'changed', before, doneA), event('2026-11-02T09:00:00Z', 'changed', doneA, reassigned), event('2026-11-02T10:00:00Z', 'deleted', deleted, null)] };
  const alice = report(ledger, [reassigned], query({ assigneeId: 'alice', issueType: 'task' }));
  assert.equal(alice.current.total, 0);
  assert.equal(alice.period.completedIssues, 1);
  assert.equal(alice.period.deleted, 1);
  assert.equal(alice.issues.find(row => row.issue.issueId === 'a')!.issue.title, 'Alice 완료 당시');
  assert.equal(alice.issues.find(row => row.issue.issueId === 'a')!.deleted, false);
  assert.equal(alice.issues.find(row => row.issue.issueId === 'gone')!.deleted, true);
  const bob = report(ledger, [reassigned], query({ assigneeId: 'bob', issueType: 'bug' }));
  assert.equal(bob.current.total, 1);
  assert.equal(bob.period.completionTransitions, 0);
  assert.equal(bob.period.deleted, 0);
  assert.equal(bob.issues[0].issue.title, '현재 Bob 제목');
});
test('current totals/deadlines use generated local today, dueDate first, endDate fallback and only open states in inclusive7-day window', () => {
  const current = [state('overdue', 'todo', { dueDate: '2026-11-02' }), state('fallback', 'review', { endDate: '2026-11-02' }), state('priority', 'todo', { dueDate: '2026-11-10', endDate: '2026-11-01' }), state('today', 'in_progress', { dueDate: '2026-11-03' }), state('day7', 'todo', { dueDate: '2026-11-10' }), state('day8', 'todo', { dueDate: '2026-11-11' }), state('done', 'done', { dueDate: '2026-11-01' }), state('cancelled', 'cancelled', { dueDate: '2026-11-01' }), state('other', 'todo', { projectId: 'other', dueDate: '2026-11-01' })];
  const value = report({ coverage: [], events: [] }, current, query({ timeZone: 'Asia/Seoul' }), '2026-11-02T16:00:00Z');
  assert.equal(value.current.total, 8);
  assert.equal(value.current.overdue, 2);
  assert.equal(value.current.dueSoon, 3);
  assert.equal(value.current.state.done, 1);
  assert.equal(value.current.state.cancelled, 1);
  assert.equal(value.observedThrough, null);
});
test('future events and future dates are not fabricated, current day is partial only through generatedAt and end gaps remain null', () => {
  const event = events(), todo = state('a', 'todo'), done = state('a', 'done');
  const ledger = { coverage: [epoch()], events: [event('2026-11-01T00:00:00Z', 'baseline', null, todo), event('2026-11-04T09:00:00Z', 'changed', todo, done)] };
  const value = report(ledger, [todo], query({ startDate: '2026-11-03', endDate: '2026-11-05' }), '2026-11-03T12:00:00Z');
  assert.equal(value.period.completionTransitions, 0);
  assert.deepEqual(value.days.map(day => day.coverage), ['partial', 'unobserved', 'unobserved']);
  assert.equal(value.days[0].state?.todo, 1);
  assert.equal(value.days[1].state, null);
  assert.equal(value.observedThrough, '2026-11-03T12:00:00.000Z');
  const gap = report({ coverage: [epoch('e', '2026-11-01T00:00:00Z', '2026-11-03T10:00:00Z')], events: [ledger.events[0]] }, [], query({ startDate: '2026-11-03', endDate: '2026-11-03' }), '2026-11-03T12:00:00Z');
  assert.equal(gap.days[0].coverage, 'partial');
  assert.equal(gap.days[0].state, null);
  assert.equal(gap.observedThrough, '2026-11-03T10:00:00.000Z');
});
test('timestamp+sequence order is deterministic, closed endpoint writes and zero-length epochs survive same-millisecond restore', () => {
  const event = events(), todo = state('a', 'todo'), active = state('a', 'in_progress'), done = state('a', 'done'), at = '2026-11-02T12:00:00Z';
  const baseline = event('2026-11-01T00:00:00Z', 'baseline', null, todo), enter = event(at, 'changed', todo, active), finish = event(at, 'changed', active, done), restored = event(at, 'baseline', null, done, 'restored');
  const value = report({ coverage: [epoch('restored', at), epoch('empty', at, at), epoch('e', '2026-11-01T00:00:00Z', at)], events: [finish, restored, baseline, enter] }, [done], query({ endDate: '2026-11-02' }));
  assert.equal(value.period.completionTransitions, 1);
  assert.equal(value.period.cycleSamples, 1);
  assert.equal(value.period.medianCycleHours, 0);
  assert.equal(value.days[0].coverage, 'partial');
  assert.equal(value.days[0].state?.done, 1);
  const endpoint = '2026-11-02T00:00:00Z', created = event(endpoint, 'created', null, state('edge', 'todo'));
  const edge = report({ coverage: [epoch('e', '2026-11-01T00:00:00Z', endpoint)], events: [created] }, [], query({ endDate: '2026-11-02' }));
  assert.equal(edge.period.created, 1);
  assert.equal(edge.days[0].coverage, 'partial');
  assert.equal(edge.days[0].state, null);
  assert.equal(edge.observedThrough, '2026-11-02T00:00:00.000Z');
});
test('report rows are complete or fail explicitly above5000 and invalid coverage/event references never silently disappear', () => {
  assert.throws(() => report({ coverage: [], events: [] }, Array.from({ length: 5001 }, (_, index) => state(String(index), 'todo'))), error(413));
  const event = events(), todo = state('a', 'todo'), missing = event('2026-11-02T00:00:00Z', 'baseline', null, todo, 'missing');
  assert.throws(() => report({ coverage: [epoch()], events: [missing] }), error(422));
  assert.throws(() => report({ coverage: [epoch(), epoch('overlap', '2026-11-03T00:00:00Z')], events: [] }), error(422));
  const first = event('2026-11-02T00:00:00Z', 'created', null, todo);
  assert.throws(() => report({ coverage: [epoch()], events: [first, { ...first, id: 'duplicate-sequence' }] }), error(422));
});

test('row snapshots follow global timestamp+sequence even when same-time zero epochs have the opposite ID sort order', () => {
  const event = events();
  const at = '2026-11-02T12:00:00Z';
  const todo = state('a', 'todo');
  const older = state('a', 'done', { title: '먼저 기록된 완료' });
  const newer = state('a', 'done', { title: '나중에 기록된 완료' });
  const ledger: ReportingLedgerData = {
    coverage: [epoch('e', at, at), epoch('a-zero', at, at), epoch('active', at)],
    events: [
      event(at, 'baseline', null, todo, 'e'),
      event(at, 'changed', todo, older, 'e'),
      event(at, 'baseline', null, todo, 'a-zero'),
      event(at, 'changed', todo, newer, 'a-zero'),
      event(at, 'baseline', null, newer, 'active'),
    ],
  };
  const result = report(ledger, [newer]);
  assert.equal(result.period.completionTransitions, 2);
  assert.equal(result.period.completedIssues, 1);
  assert.equal(result.issues[0].issue.title, '나중에 기록된 완료');
});
