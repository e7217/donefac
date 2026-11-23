import { calendarDate, calendarDay, isCalendarDate } from '../shared/calendar.js';
import { reservationDayRange, reservationLocalDateTime } from '../shared/time-reservations.js';
import { CYCLE_PROGRESS_EVIDENCE_LIMIT, CYCLE_PROGRESS_MAX_DAYS } from '../shared/types.js';
import type {
  CycleProgressDay, CycleProgressEvidence, CycleProgressReport, CycleProgressState,
  IssueReportEvent, PlanningItem, ReportingLedgerData, ReportIssueState,
} from '../shared/types.js';

const timeZone = 'Asia/Seoul';
type Cycle = Pick<PlanningItem, 'id' | 'projectId' | 'name' | 'startDate' | 'endDate' | 'status' | 'createdAt'>;
type Options = { completedAt?: string | null; throughDate?: string; evidenceDate?: string; offset?: number };
type ChangeCounts = NonNullable<CycleProgressDay['changes']>;
type EvidenceItem = CycleProgressEvidence['items'][number];
type Change = EvidenceItem['kinds'][number];
type EstimateTotal = { sum: number; residual: number };
type Observation = {
  started: number;
  ended: number;
  state: Omit<CycleProgressState, 'scopeEstimate' | 'remainingEstimate'>;
  scopeEstimate: EstimateTotal;
  remainingEstimate: EstimateTotal;
};

export class CycleProgressError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

function time(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new CycleProgressError(422, '사이클 진행의 관측 시각을 확인해 주세요.');
  return timestamp;
}

function localDate(instant: string): string {
  const date = reservationLocalDateTime(instant, timeZone).slice(0, 10);
  if (!isCalendarDate(date)) throw new CycleProgressError(422, '사이클 진행의 관측 날짜를 확인해 주세요.');
  return date;
}

function emptyChanges(): ChangeCounts {
  return { added: 0, removed: 0, completed: 0, cancelled: 0, reopened: 0, estimateChanged: 0, reclassified: 0 };
}

function estimatedPoints(issue: ReportIssueState): number | null {
  return issue.estimate ?? null;
}

function isRemaining(issue: ReportIssueState): boolean {
  return issue.category !== 'done' && issue.category !== 'cancelled';
}

function adjustEstimate(total: EstimateTotal, delta: number, estimatedIssues: number): void {
  if (estimatedIssues === 0) {
    total.sum = 0;
    total.residual = 0;
    return;
  }
  // Compensated summation preserves small estimates when a much larger one is later removed.
  const sum = total.sum + delta;
  total.residual += Math.abs(total.sum) >= Math.abs(delta) ? (total.sum - sum) + delta : (delta - sum) + total.sum;
  total.sum = sum;
}

function adjust(observation: Observation, issue: ReportIssueState, delta: 1 | -1): void {
  const { state, scopeEstimate, remainingEstimate } = observation;
  const estimate = estimatedPoints(issue);
  state.scopeIssues += delta;
  if (estimate === null) state.missingScopeEstimate += delta;
  else adjustEstimate(scopeEstimate, estimate * delta, state.scopeIssues - state.missingScopeEstimate);
  if (isRemaining(issue)) {
    state.remainingIssues += delta;
    if (estimate === null) state.missingRemainingEstimate += delta;
    else adjustEstimate(remainingEstimate, estimate * delta, state.remainingIssues - state.missingRemainingEstimate);
  } else if (issue.category === 'done') {
    state.completedIssues += delta;
  } else {
    state.cancelledIssues += delta;
  }
}

function changesFor(kind: IssueReportEvent['kind'], before: ReportIssueState | null, after: ReportIssueState | null): Change[] {
  if (kind === 'baseline' || kind === 'cycle_baseline') return [];
  if (!before) return after ? ['added'] : [];
  if (!after) return ['removed'];
  const changes: Change[] = [];
  if (before.category !== after.category) {
    if (kind === 'reclassified') changes.push('reclassified');
    else if (after.category === 'done') changes.push('completed');
    else if (after.category === 'cancelled') changes.push('cancelled');
    else if (!isRemaining(before)) changes.push('reopened');
  }
  if (estimatedPoints(before) !== estimatedPoints(after)) changes.push('estimateChanged');
  return changes;
}

export function aggregateCycleProgress(cycle: Cycle, ledger: ReportingLedgerData, generatedAt: string, options: Options = {}): Omit<CycleProgressReport, 'revision'> {
  const { id, projectId, name, startDate, endDate, status } = cycle;
  const generated = time(generatedAt);
  const completedAt = status === 'completed' && options.completedAt && time(options.completedAt) <= generated ? options.completedAt : null;
  const through = completedAt === null ? generated : time(completedAt);
  const firstDate = startDate ?? localDate(cycle.createdAt);
  const observedEnd = localDate(completedAt ?? generatedAt);
  const lastDate = observedEnd < firstDate ? null : observedEnd;
  const windowEnd = lastDate === null ? null : options.throughDate && options.throughDate < lastDate ? options.throughDate : lastDate;
  const windowStart = windowEnd !== null && windowEnd >= firstDate
    ? calendarDate(Math.max(calendarDay(firstDate), calendarDay(windowEnd) - CYCLE_PROGRESS_MAX_DAYS + 1)) : null;
  const output: Omit<CycleProgressReport, 'revision'> = {
    cycle: { id, projectId, name, startDate, endDate, status }, generatedAt, timeZone,
    firstDate, lastDate, windowStart, windowEnd: windowStart === null ? null : windowEnd,
    completedAt, days: [], evidence: null,
  };
  if (windowStart === null || windowEnd === null) return output;

  const created = time(cycle.createdAt);
  const observations: Observation[] = [];
  const byCoverage = new Map<string, Observation>();
  for (const coverage of ledger.coverage) {
    if (coverage.cycleStartedAt === undefined) continue;
    const recordedFrom = time(coverage.cycleStartedAt);
    const ended = coverage.endedAt === null ? Infinity : time(coverage.endedAt);
    if (ended < recordedFrom || (observations.at(-1)?.ended ?? -Infinity) > recordedFrom || byCoverage.has(coverage.id)) {
      throw new CycleProgressError(422, '사이클 진행의 관측 구간을 확인해 주세요.');
    }
    const started = Math.max(recordedFrom, created);
    if (ended < started) continue;
    const period: Observation = {
      started, ended, scopeEstimate: { sum: 0, residual: 0 }, remainingEstimate: { sum: 0, residual: 0 },
      state: { scopeIssues: 0, remainingIssues: 0, completedIssues: 0, cancelledIssues: 0,
        missingScopeEstimate: 0, missingRemainingEstimate: 0 },
    };
    observations.push(period);
    byCoverage.set(coverage.id, period);
  }

  const targetDate = options.evidenceDate;
  const evidence: CycleProgressEvidence | null = targetDate && targetDate >= windowStart && targetDate <= windowEnd
    ? { date: targetDate, offset: options.offset ?? 0, limit: CYCLE_PROGRESS_EVIDENCE_LIMIT, total: 0, items: [] } : null;
  output.evidence = evidence;
  const member = (value: ReportIssueState | null) => value?.projectId === projectId && value.cycleId === id ? value : null;
  // The ledger orders events by observation time and sequence, including pre-window baselines.
  let eventIndex = 0;
  let coverageIndex = 0;
  const finalDay = calendarDay(windowEnd);
  for (let day = calendarDay(windowStart); day <= finalDay; day++) {
    const date = calendarDate(day);
    const boundary = reservationDayRange(date, timeZone);
    if (!boundary) throw new CycleProgressError(422, '사이클 진행의 날짜 경계를 확인해 주세요.');
    const started = time(boundary.startAt);
    const last = time(boundary.endAt) - 1;
    const asOf = Math.min(through, last);
    const entireDay = through > last;
    // A new epoch's baseline is separate evidence, even when a restore starts at the old epoch's end.
    while (coverageIndex < observations.length && observations[coverageIndex].ended < started) coverageIndex++;
    let hasObservation = false;
    let snapshot: Observation | null = null;
    for (let index = coverageIndex; index < observations.length && observations[index].started <= asOf; index++) {
      const observation = observations[index];
      if (observation.ended < started) continue;
      hasObservation = true;
      if (observation.ended >= asOf) snapshot = observation;
    }

    const changes = hasObservation ? emptyChanges() : null;
    while (eventIndex < ledger.events.length) {
      const event = ledger.events[eventIndex];
      const occurredAt = time(event.occurredAt);
      if (occurredAt > asOf) break;
      eventIndex++;
      const period = byCoverage.get(event.coverageId);
      if (event.projectId !== projectId || !period || occurredAt < period.started || occurredAt > period.ended) continue;
      const before = member(event.before);
      const after = member(event.after);
      if (before) adjust(period, before, -1);
      if (after) adjust(period, after, 1);
      if (occurredAt < started || changes === null) continue;
      const kinds = changesFor(event.kind, before, after);
      for (const kind of kinds) changes[kind]++;
      if (!evidence || evidence.date !== date || !kinds.length) continue;
      const ordinal = evidence.total++;
      if (ordinal < evidence.offset || evidence.items.length >= evidence.limit) continue;
      const issue = (after ?? before)!;
      evidence.items.push({ id: event.id, occurredAt: event.occurredAt, issueId: issue.issueId, key: issue.key, title: issue.title,
        kinds, beforeEstimate: before ? estimatedPoints(before) : null, afterEstimate: after ? estimatedPoints(after) : null });
    }

    const complete = entireDay && snapshot !== null && snapshot.started <= started;
    const state = snapshot ? { ...snapshot.state, scopeEstimate: Math.max(0, snapshot.scopeEstimate.sum + snapshot.scopeEstimate.residual),
      remainingEstimate: Math.max(0, snapshot.remainingEstimate.sum + snapshot.remainingEstimate.residual) } : null;
    output.days.push({ date, coverage: complete ? 'complete' : hasObservation ? 'partial' : 'unobserved',
      state, changes });
  }
  return output;
}
