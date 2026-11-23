import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateCycleProgress } from '../../server/cycle-progress.js';
import { CYCLE_PROGRESS_EVIDENCE_LIMIT, CYCLE_PROGRESS_MAX_DAYS } from '../../shared/types.js';
import type { IssueReportEvent, PlanningItem, ReportingCoverage, ReportIssueState, StatusCategory } from '../../shared/types.js';

const cycle: Pick<PlanningItem, 'id' | 'projectId' | 'name' | 'status' | 'startDate' | 'endDate' | 'createdAt'> = {
  id: 'cycle-a', projectId: 'project-a', name: '11월 사이클', status: 'active',
  startDate: '2026-11-19', endDate: '2026-11-20', createdAt: '2026-11-18T04:00:00.000Z',
};

function issue(issueId: string, estimate: number | null, category: StatusCategory = 'todo', cycleId = cycle.id): ReportIssueState {
  return { issueId, key: `TEAM-${issueId}`, title: `업무 ${issueId}`, projectId: cycle.projectId,
    type: 'task', statusId: category, statusLabel: category, category, estimate, cycleId, assigneeId: null,
    startDate: null, endDate: null, dueDate: null };
}

const observation = (id: string, startedAt: string, endedAt: string | null = null, cycleStartedAt = startedAt): ReportingCoverage =>
  ({ id, startedAt, endedAt, reason: 'initial', cycleStartedAt });

function event(sequence: number, occurredAt: string, kind: IssueReportEvent['kind'], before: ReportIssueState | null,
  after: ReportIssueState | null, coverageId = 'observed'): IssueReportEvent {
  const state = after ?? before!;
  return { id: `event-${sequence}`, sequence, occurredAt, kind, projectId: state.projectId, issueId: state.issueId,
    coverageId, before, after, actorId: null, origin: 'system', workflowVersion: 1 };
}

test('Seoul daily cycle progress models logged membership, zero and missing estimates, completion and reclassification', () => {
  const old = issue('1', 3);
  const reestimatedDone = issue('1', 5, 'done');
  const reopened = issue('1', 5, 'todo');
  const noEstimate = issue('2', null);
  const zero = issue('3', 0);
  const reclassified = { ...zero, category: 'cancelled' as const };
  const differentCycle = issue('4', 19, 'todo', 'same-name-cycle');
  const ledger = {
    coverage: [observation('observed', '2026-11-18T15:00:00.000Z', null, '2026-11-20T00:00:00.000Z')],
    events: [
      event(1, '2026-11-20T00:00:00.000Z', 'cycle_baseline', { ...old, cycleId: undefined, estimate: undefined }, old),
      event(2, '2026-11-20T01:00:00.000Z', 'baseline', null, noEstimate),
      event(3, '2026-11-20T14:59:59.999Z', 'changed', old, reestimatedDone),
      event(4, '2026-11-20T15:00:00.000Z', 'created', null, zero),
      event(5, '2026-11-21T01:00:00.000Z', 'changed', noEstimate, { ...noEstimate, cycleId: 'next' }),
      event(6, '2026-11-21T02:00:00.000Z', 'changed', reestimatedDone, reopened),
      event(7, '2026-11-21T03:00:00.000Z', 'reclassified', zero, reclassified),
      event(8, '2026-11-21T04:00:00.000Z', 'created', null, differentCycle),
      event(9, '2026-11-22T03:00:00.000Z', 'changed', reopened, issue('1', 5, 'cancelled')),
      event(10, '2026-11-22T09:00:00.000Z', 'changed', reclassified, zero),
    ],
  };
  const now = '2026-11-22T04:00:00.000Z';
  const report = aggregateCycleProgress(cycle, ledger, now, { evidenceDate: '2026-11-21' });
  assert.equal(report.firstDate, '2026-11-19');
  assert.equal(report.lastDate, '2026-11-22');
  const [unobserved, first, second, today] = report.days;
  assert.deepEqual(unobserved, { date: '2026-11-19', coverage: 'unobserved', state: null, changes: null });
  assert.equal(first.coverage, 'partial');
  assert.deepEqual(first.state, { scopeIssues: 2, remainingIssues: 1, completedIssues: 1, cancelledIssues: 0,
    scopeEstimate: 5, remainingEstimate: 0, missingScopeEstimate: 1, missingRemainingEstimate: 1 });
  assert.deepEqual(first.changes, { added: 0, removed: 0, completed: 1, cancelled: 0, reopened: 0, estimateChanged: 1, reclassified: 0 });
  assert.equal(second.coverage, 'complete');
  assert.deepEqual(second.state, { scopeIssues: 2, remainingIssues: 1, completedIssues: 0, cancelledIssues: 1,
    scopeEstimate: 5, remainingEstimate: 5, missingScopeEstimate: 0, missingRemainingEstimate: 0 });
  assert.deepEqual(second.changes, { added: 1, removed: 1, completed: 0, cancelled: 0, reopened: 1, estimateChanged: 0, reclassified: 1 });
  assert.equal(today.coverage, 'partial');
  assert.equal(today.state?.remainingIssues, 0);
  assert.equal(today.changes?.cancelled, 1);
  assert.equal(today.changes?.reopened, 0);
  assert.deepEqual(report.evidence?.items.map(({ id, kinds, beforeEstimate, afterEstimate }) =>
    ({ id, kinds, beforeEstimate, afterEstimate })), [
    { id: 'event-4', kinds: ['added'], beforeEstimate: null, afterEstimate: 0 },
    { id: 'event-5', kinds: ['removed'], beforeEstimate: null, afterEstimate: null },
    { id: 'event-6', kinds: ['reopened'], beforeEstimate: 5, afterEstimate: 5 },
    { id: 'event-7', kinds: ['reclassified'], beforeEstimate: 0, afterEstimate: 0 },
  ]);
  assert.equal(report.evidence?.total, 4);
});

test('backup gaps remove unknown closing snapshots and even a same-millisecond restore resets the cycle baseline', () => {
  const first = issue('1', 5);
  const replacement = issue('2', null);
  const later = issue('3', 8);
  const adjacent = '2026-11-23T14:59:59.999Z';
  const ledger = {
    coverage: [
      observation('observed', '2026-11-19T15:00:00.000Z', '2026-11-21T00:00:00.000Z'),
      observation('restored', '2026-11-22T15:00:00.000Z', adjacent),
      observation('adjacent', adjacent),
    ],
    events: [
      event(1, '2026-11-19T15:00:00.000Z', 'baseline', null, first),
      event(2, '2026-11-20T18:00:00.000Z', 'changed', first, { ...first, estimate: 7 }),
      event(3, '2026-11-22T15:00:00.000Z', 'baseline', null, replacement, 'restored'),
      event(4, adjacent, 'baseline', null, later, 'adjacent'),
    ],
  };
  const report = aggregateCycleProgress({ ...cycle, startDate: '2026-11-20' }, ledger, '2026-11-24T17:00:00.000Z');
  assert.deepEqual(report.days.map(day => [day.date, day.coverage, day.state?.remainingEstimate ?? null, day.changes?.estimateChanged ?? null]), [
    ['2026-11-20', 'complete', 5, 0],
    ['2026-11-21', 'partial', null, 1],
    ['2026-11-22', 'unobserved', null, null],
    ['2026-11-23', 'partial', 8, 0],
    ['2026-11-24', 'complete', 8, 0],
    ['2026-11-25', 'partial', 8, 0],
  ]);
  assert.equal(report.days[3].changes?.added, 0);
  assert.equal(report.days[3].changes?.removed, 0);
});

test('a confirmed completion includes same-instant carry but excludes later edits and future dates', () => {
  const carry = issue('1', 3);
  const retained = issue('2', 2, 'done');
  const completedAt = '2026-11-20T15:00:00.000Z';
  const now = '2026-11-22T05:00:00.000Z';
  const ledger = {
    coverage: [observation('observed', '2026-11-18T15:00:00.000Z')],
    events: [
      event(1, '2026-11-20T03:00:00.000Z', 'created', null, carry),
      event(2, '2026-11-20T04:00:00.000Z', 'created', null, retained),
      event(3, completedAt, 'changed', carry, { ...carry, cycleId: 'next' }),
      event(4, '2026-11-20T15:00:00.001Z', 'changed', retained, { ...retained, category: 'todo' }),
    ],
  };
  const report = aggregateCycleProgress({ ...cycle, status: 'completed' }, ledger, now,
    { completedAt, evidenceDate: '2026-11-21', throughDate: '2026-12-01' });
  assert.equal(report.lastDate, '2026-11-21');
  assert.equal(report.windowEnd, '2026-11-21');
  assert.equal(report.completedAt, completedAt);
  assert.equal(report.days.at(-1)?.coverage, 'partial');
  assert.equal(report.days.at(-1)?.state?.remainingIssues, 0);
  assert.equal(report.days.at(-1)?.state?.completedIssues, 1);
  assert.deepEqual(report.evidence?.items.map(item => [item.id, item.kinds]), [['event-3', ['removed']]]);
  assert.equal(aggregateCycleProgress(cycle, ledger, now, { completedAt }).days.at(-1)?.state?.remainingIssues, 1);
  const future = aggregateCycleProgress({ ...cycle, startDate: '2026-11-30' }, ledger, now);
  assert.equal(future.lastDate, null);
  assert.equal(future.windowStart, null);
  assert.deepEqual(future.days, []);
  const noStart = aggregateCycleProgress({ ...cycle, startDate: null, createdAt: '2026-11-18T16:00:00.000Z' }, ledger, now);
  assert.equal(noStart.firstDate, '2026-11-19');
});

test('a backdated cycle keeps its planned start and marks dates before local creation unobserved', () => {
  const createdAt = '2026-11-20T04:00:00.000Z';
  const ledger = {
    coverage: [observation('observed', '2026-11-17T15:00:00.000Z')],
    events: [event(1, createdAt, 'created', null, issue('1', 5))],
  };
  const report = aggregateCycleProgress({ ...cycle, createdAt }, ledger, '2026-11-21T09:00:00.000Z');
  assert.equal(report.firstDate, '2026-11-19');
  assert.deepEqual(report.days.map(day => [day.date, day.coverage, day.state?.remainingEstimate ?? null, day.changes?.added ?? null]), [
    ['2026-11-19', 'unobserved', null, null],
    ['2026-11-20', 'partial', 5, 1],
    ['2026-11-21', 'partial', 5, 0],
  ]);
});

test('removing a large estimate retains the smaller recorded estimate', () => {
  const large = issue('1', 100_000);
  const small = issue('2', 1e-18);
  const ledger = {
    coverage: [observation('observed', '2026-11-18T15:00:00.000Z')],
    events: [
      event(1, '2026-11-19T04:00:00.000Z', 'created', null, large),
      event(2, '2026-11-19T05:00:00.000Z', 'created', null, small),
      event(3, '2026-11-20T04:00:00.000Z', 'deleted', large, null),
    ],
  };
  const report = aggregateCycleProgress(cycle, ledger, '2026-11-20T09:00:00.000Z');
  assert.equal(report.days.at(-1)?.state?.scopeEstimate, 1e-18);
  assert.equal(report.days.at(-1)?.state?.remainingEstimate, 1e-18);
});

test('the date window and evidence page are bounded without dropping pre-window state or day totals', () => {
  const old = issue('old', 2.5);
  const eventCount = CYCLE_PROGRESS_EVIDENCE_LIMIT + 5;
  const events = [event(1, '2026-01-01T02:00:00.000Z', 'baseline', null, old)];
  for (let index = 0; index < eventCount; index++) {
    events.push(event(index + 2, '2026-06-12T00:00:00.000Z', 'created', null, issue(String(index), null)));
  }
  const ledger = { coverage: [observation('observed', '2026-01-01T02:00:00.000Z')], events };
  const report = aggregateCycleProgress({ ...cycle, startDate: '2026-01-01', createdAt: '2025-12-30T05:00:00.000Z' },
    ledger, '2026-11-22T05:00:00.000Z', { throughDate: '2026-06-12', evidenceDate: '2026-06-12', offset: CYCLE_PROGRESS_EVIDENCE_LIMIT });
  assert.equal(report.lastDate, '2026-11-22');
  assert.equal(report.windowEnd, '2026-06-12');
  assert.equal(report.days.length, CYCLE_PROGRESS_MAX_DAYS);
  assert.equal(report.days[0].state?.scopeEstimate, 2.5);
  assert.equal(report.days.at(-1)?.changes?.added, eventCount);
  assert.equal(report.days.at(-1)?.state?.scopeIssues, eventCount + 1);
  assert.equal(report.days.at(-1)?.state?.missingRemainingEstimate, eventCount);
  assert.equal(report.evidence?.total, eventCount);
  assert.equal(report.evidence?.items.length, 5);
  assert.equal(report.evidence?.items[0].id, `event-${CYCLE_PROGRESS_EVIDENCE_LIMIT + 2}`);
});
