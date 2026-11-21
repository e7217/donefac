import type { IssueReportEvent, ProjectReport, ReportDay, ReportIssueMetric, ReportIssueState, ReportOpenStatusIssue, ReportQuery, ReportingCoverage, ReportingLedgerData, ReportStatusVisitMetric, StatusCategory } from '../shared/types.js';
import { calendarDay, isCalendarDate } from '../shared/calendar.js';
export class ReportingMetricsError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
const DAY = 86400000, HOUR = 3600000, MAX_REPORT_ISSUES = 5000;
const categories: StatusCategory[] = ['backlog', 'todo', 'in_progress', 'review', 'done', 'cancelled'];
function fail(status: number, message: string): never {
  throw new ReportingMetricsError(status, message);
}
function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > 200 || /[\x00-\x1f\x7f]/.test(value))
    fail(400, `${label} 식별자를 확인해 주세요.`);
  return value;
}
function date(value: unknown): string {
  if (!isCalendarDate(value))
    fail(400, '날짜는 올바른 YYYY-MM-DD여야 합니다.');
  return value;
}
function instant(value: string): number {
  const iso = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
  if (typeof value !== 'string' || !iso.test(value) ||
      !isCalendarDate(value.slice(0, 10)) || !Number.isFinite(Date.parse(value)))
    fail(422, '보고서 관측 시각은 유효한 절대 시각이어야 합니다.');
  return Date.parse(value);
}
const emptyState = (): Record<StatusCategory, number> => ({
  backlog: 0, todo: 0, in_progress: 0, review: 0, done: 0, cancelled: 0
});
const terminal = (state: ReportIssueState) => state.category === 'done' || state.category === 'cancelled';
const working = (state: ReportIssueState) => state.category === 'in_progress' || state.category === 'review';
const sameStatus = (before: ReportIssueState | null | undefined, after: ReportIssueState) =>
  before?.projectId === after.projectId && before.statusId === after.statusId;
function medianSortedHours(sorted: number[]): number | null {
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
export function parseReportQuery(input: unknown): ReportQuery {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    fail(400, '보고서 조회 조건이 필요합니다.');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['projectId', 'startDate', 'endDate', 'timeZone', 'issueType', 'assigneeId'].includes(key)))
    fail(400, '지원하지 않는 보고서 조회 조건입니다.');
  const startDate = date(value.startDate);
  const endDate = date(value.endDate);
  const count = calendarDay(endDate) - calendarDay(startDate) + 1;
  if (count < 1 || count > 92)
    fail(400, '보고서 기간은 종료일을 포함해 1~92일이어야 합니다.');
  if (typeof value.timeZone !== 'string' || !value.timeZone || value.timeZone.trim() !== value.timeZone || value.timeZone.length > 100 || /^[+-]/.test(value.timeZone))
    fail(400, 'IANA 시간대를 선택해 주세요.');
  try {
    new Intl.DateTimeFormat('en', { timeZone: value.timeZone }).format(0);
  }
  catch {
    fail(400, '유효한 IANA 시간대를 선택해 주세요.');
  }
  const selector = (value: unknown, label: string) => value === null || value === undefined || value === '' ? null : id(value, label);
  return {
    projectId: id(value.projectId, '프로젝트'),
    startDate,
    endDate,
    timeZone: value.timeZone,
    issueType: selector(value.issueType, '업무 유형'),
    assigneeId: selector(value.assigneeId, '담당자'),
  };
}
/** Intl uses the runtime's IANA database. Calendar arithmetic deliberately uses
 * UTC day ordinals, never Date.UTC's special 0..99 year normalization.
 * https://tc39.es/ecma402/#sec-intl.datetimeformat.prototype.formattoparts */
class LocalDays {
  private formatter: Intl.DateTimeFormat;
  private cache = new Map<number, number>();
  constructor(timeZone: string) {
    this.formatter = new Intl.DateTimeFormat('en-GB-u-ca-gregory-nu-latn', {
      timeZone, era: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    });
  }
  parts(at: number) {
    const values = Object.fromEntries(this.formatter.formatToParts(at).map(value => [value.type, value.value]));
    const year = values.era === 'BC' ? 1 - Number(values.year) : Number(values.year);
    const date = new Date(0);
    date.setUTCFullYear(year, Number(values.month) - 1, Number(values.day));
    date.setUTCHours(Number(values.hour), Number(values.minute), Number(values.second), 0);
    return {
      day: Math.floor(date.getTime() / DAY), local: date.getTime(), midnight: values.hour === '00' && values.minute === '00' && values.second === '00'
    };
  }
  day(at: number) {
    return this.parts(at).day;
  }
  start(day: number): number {
    const cached = this.cache.get(day);
    if (cached !== undefined)
      return cached;
    const naive = day * DAY, offsets = new Set<number>();
    // Sample both sides of IANA transitions. Matching candidates select the
    // earliest midnight on a repeated day, rather than assuming 24 UTC hours.
    for (let at = naive - 2 * DAY; at <= naive + 2 * DAY; at += 3 * HOUR)
      offsets.add(this.parts(at).local - at);
    const candidates = [...offsets].map(offset => naive - offset).filter(at => {
      const value = this.parts(at);
      return value.day === day && value.midnight;
    });
    if (candidates.length) {
      const value = Math.min(...candidates);
      this.cache.set(day, value);
      return value;
    }
    // A skipped midnight starts at the first valid local time; an entirely
    // skipped date has the same boundary as the following date (zero duration).
    let previous = naive - 2 * DAY;
    for (let at = previous + HOUR; at <= naive + 2 * DAY; at += HOUR) {
      if (this.day(at) >= day && this.day(previous) < day) {
        let low = previous, high = at;
        while (high - low > 1) {
          const mid = Math.floor((low + high) / 2);
          if (this.day(mid) >= day)
            high = mid;
          else
            low = mid;
        }
        this.cache.set(day, high);
        return high;
      }
      previous = at;
    }
    return fail(422, '해당 시간대의 날짜 경계를 확정할 수 없습니다.');
  }
}
interface Epoch {
  coverage: ReportingCoverage;
  start: number;
  end: number;
  events: {
    event: IssueReportEvent;
    at: number;
  }[];
}
interface DayWork {
  day: number;
  start: number;
  end: number;
  output: ReportDay;
  epoch: Epoch | null;
  at: number;
  inclusive: boolean;
}
interface StatusVisits {
  state: ReportIssueState;
  latest: { at: number; sequence: number };
  hours: number[];
  unknownEntries: number;
}
export function aggregateProjectReport(rawQuery: ReportQuery, input: {
  current: ReportIssueState[];
  ledger: ReportingLedgerData;
  generatedAt: string;
}): ProjectReport {
  const query = parseReportQuery(rawQuery);
  const generated = instant(input.generatedAt);
  const local = new LocalDays(query.timeZone);
  const startDay = calendarDay(query.startDate);
  const endDay = calendarDay(query.endDate);
  const rangeStart = local.start(startDay);
  const rangeEnd = local.start(endDay + 1);
  const today = local.day(generated);
  const matches = (state: ReportIssueState | null): state is ReportIssueState => Boolean(
    state &&
    state.projectId === query.projectId &&
    (query.issueType === null || state.type === query.issueType) &&
    (query.assigneeId === null || state.assigneeId === query.assigneeId)
  );
  const epochs: Epoch[] = input.ledger.coverage.map(value => ({
    coverage: structuredClone(value),
    start: instant(value.startedAt),
    end: value.endedAt === null ? Infinity : instant(value.endedAt),
    events: [],
  })).sort((a, b) => a.start - b.start || a.end - b.end || a.coverage.id.localeCompare(b.coverage.id));
  const byEpoch = new Map<string, Epoch>();
  for (let index = 0; index < epochs.length; index++) {
    const epoch = epochs[index];
    if (byEpoch.has(epoch.coverage.id) || epoch.end < epoch.start || index > 0 && epochs[index - 1].end > epoch.start)
      fail(422, '관측 구간이 중복되거나 순서가 올바르지 않습니다.');
    byEpoch.set(epoch.coverage.id, epoch);
  }
  const sequences = new Set<number>(), eventIds = new Set<string>();
  for (const event of input.ledger.events) {
    const epoch = byEpoch.get(event.coverageId), at = instant(event.occurredAt);
    const invalidSequence = !Number.isSafeInteger(event.sequence) || event.sequence < 1;
    const duplicateEvent = sequences.has(event.sequence) || eventIds.has(event.id);
    if (!epoch || at < epoch.start || at > epoch.end || invalidSequence || duplicateEvent)
      fail(422, '관측 이벤트 구간·순서가 올바르지 않습니다.');
    const invalidIdentity = (state: ReportIssueState | null) => state && (
      state.issueId !== event.issueId || state.projectId !== event.projectId
    );
    if (invalidIdentity(event.before) || invalidIdentity(event.after))
      fail(422, '관측 업무의 식별자가 일치하지 않습니다.');
    for (const state of [event.before, event.after])
      if (state && !categories.includes(state.category))
        fail(422, '관측 상태 분류가 올바르지 않습니다.');
    sequences.add(event.sequence);
    eventIds.add(event.id);
    epoch.events.push({ event, at });
  }
  for (const epoch of epochs)
    epoch.events.sort((a, b) => a.at - b.at || a.event.sequence - b.event.sequence);
  const days: DayWork[] = [];
  for (let day = startDay; day <= endDay; day++) {
    const start = local.start(day);
    const end = local.start(day + 1);
    const isFinishedDay = end <= generated;
    const hasObservation = end > start && start <= generated && epochs.some(epoch =>
      epoch.start <= Math.min(end - 1, generated) && epoch.end >= start
    );
    const isFullyCovered = isFinishedDay && end > start && epochs.some(epoch =>
      epoch.start <= start && epoch.end >= end
    );
    // Past snapshots exclude midnight writes for the next day. Today's
    // snapshot includes generatedAt only while that instant is observed.
    const snapshotEpoch = isFinishedDay
      ? epochs.find(epoch => epoch.start < end && epoch.end >= end)
      : day === today
        ? epochs.find(epoch => epoch.start <= generated && epoch.end > generated)
        : undefined;
    days.push({
      day,
      start,
      end,
      output: {
        date: new Date(day * DAY).toISOString().slice(0, 10),
        coverage: isFullyCovered ? 'complete' : hasObservation ? 'partial' : 'unobserved',
        state: null,
        created: 0,
        completed: 0,
        reopened: 0,
      },
      epoch: end > start ? snapshotEpoch || null : null,
      at: isFinishedDay ? end : generated,
      inclusive: !isFinishedDay,
    });
  }
  const dayMap = new Map(days.map(value => [value.day, value.output]));
  const currentState = emptyState();
  const current = input.current.filter(matches);
  const currentIds = new Set<string>();
  const movedOutIds = new Set<string>();
  for (const epoch of epochs) {
    for (const { event, at } of epoch.events) {
      if (at > generated || event.projectId !== query.projectId) continue;
      if (event.kind === 'moved_out') movedOutIds.add(event.issueId);
      else if (event.after) movedOutIds.delete(event.issueId);
    }
  }
  const issueMetrics = new Map<string, ReportIssueMetric>();
  const latestMetricEvent = new Map<string, { at: number; sequence: number }>();
  const latestCompletion = new Map<string, { at: number; sequence: number }>();
  const follows = (previous: { at: number; sequence: number } | undefined, at: number, sequence: number) =>
    !previous || at > previous.at || at === previous.at && sequence > previous.sequence;
  const completedIssueIds = new Set<string>();
  const cycleSamplesHours: number[] = [];
  const statusVisits = new Map<string, StatusVisits>();
  const openStatusEntries = new Map<string, number>();
  const currentEpoch = epochs.find(epoch => epoch.start <= generated && epoch.end > generated);
  const period: ProjectReport['period'] = {
    created: 0,
    deleted: 0,
    completedIssues: 0,
    completionTransitions: 0,
    repeatedCompletions: 0,
    reopened: 0,
    reclassified: 0,
    medianCycleHours: null,
    cycleSamples: 0,
  };
  for (const issue of input.current) {
    if (currentIds.has(issue.issueId) || !categories.includes(issue.category))
      fail(422, '현재 보고서 업무 목록이 중복되거나 올바르지 않습니다.');
    currentIds.add(issue.issueId);
  }
  const ensureIssueMetric = (issue: ReportIssueState) => {
    let value = issueMetrics.get(issue.issueId);
    if (!value) {
      if (issueMetrics.size >= MAX_REPORT_ISSUES)
        fail(413, '보고서 업무가 5,000개를 초과했습니다. 기간·유형·담당자를 좁혀 주세요.');
      const movedOut = !currentIds.has(issue.issueId) && movedOutIds.has(issue.issueId);
      value = {
        issue: structuredClone(issue),
        completed: 0,
        reopened: 0,
        lastCompletedAt: null,
        cycleHours: null,
        deleted: !currentIds.has(issue.issueId) && !movedOut,
        ...(movedOut ? { movedOut: true as const } : {}),
      };
      issueMetrics.set(issue.issueId, value);
    }
    return value;
  };
  let overdue = 0, dueSoon = 0;
  for (const issue of current) {
    currentState[issue.category]++;
    ensureIssueMetric(issue);
    const due = issue.dueDate ?? issue.endDate;
    if (!terminal(issue) && due !== null) {
      if (!isCalendarDate(due))
        fail(422, '현재 업무의 마감일이 올바르지 않습니다.');
      const day = calendarDay(due);
      if (day < today)
        overdue++;
      else if (day <= today + 7)
        dueSoon++;
    }
  }
  for (const epoch of epochs) {
    const knownStates = new Map<string, ReportIssueState>();
    const snapshotCounts = emptyState();
    const cycleStartedAt = new Map<string, number>();
    const statusEnteredAt = new Map<string, number>();
    const snapshotRequests = days
      .filter(day => day.epoch === epoch)
      .sort((a, b) => a.at - b.at);
    let eventCursor = 0;
    const applyObservedEvent = ({ event, at }: {
      event: IssueReportEvent;
      at: number;
    }) => {
      const before = event.before;
      const after = event.after;
      const previous = knownStates.get(event.issueId);
      const statusChanged = event.kind === 'changed' && before !== null && after !== null && before.statusId !== after.statusId;
      if (statusChanged && at >= rangeStart && at < rangeEnd && matches(before)) {
        let visits = statusVisits.get(before.statusId);
        if (!visits) {
          if (statusVisits.size >= MAX_REPORT_ISSUES)
            fail(413, '보고서에 관측된 상태가 5,000개를 초과했습니다. 기간·유형·담당자를 좁혀 주세요.');
          visits = { state: before, latest: { at, sequence: event.sequence }, hours: [], unknownEntries: 0 };
          statusVisits.set(before.statusId, visits);
        }
        else if (follows(visits.latest, at, event.sequence)) {
          visits.state = before;
          visits.latest = { at, sequence: event.sequence };
        }
        const enteredAt = sameStatus(previous, before) ? statusEnteredAt.get(event.issueId) : undefined;
        if (enteredAt === undefined) visits.unknownEntries++;
        else visits.hours.push((at - enteredAt) / HOUR);
      }
      if (statusChanged || ((event.kind === 'created' || event.kind === 'moved_in') && before === null && after !== null)) {
        statusEnteredAt.set(event.issueId, at);
      }
      // Baselines and restores establish a state without establishing its entry time.
      else if (!after || !sameStatus(before, after) || !sameStatus(previous, after)) {
        statusEnteredAt.delete(event.issueId);
      }
      if (matches(previous || null))
        snapshotCounts[previous!.category]--;
      if (after) {
        knownStates.set(event.issueId, after);
        if (matches(after))
          snapshotCounts[after.category]++;
      }
      else
        knownStates.delete(event.issueId);
      const isCompletion = event.kind === 'changed' &&
        before !== null && after !== null &&
        before.category !== 'done' && after.category === 'done';
      const isReopen = event.kind === 'changed' &&
        before?.category === 'done' && after !== null && !terminal(after);
      const cycle = isCompletion && cycleStartedAt.has(event.issueId)
        ? (at - cycleStartedAt.get(event.issueId)!) / HOUR
        : null;
      if (event.kind === 'baseline' || event.kind === 'restored' || event.kind === 'moved_in')
        cycleStartedAt.delete(event.issueId);
      else if (event.kind === 'reclassified') {
        if (before?.category !== after?.category)
          cycleStartedAt.delete(event.issueId);
      }
      else if (after === null || terminal(after))
        cycleStartedAt.delete(event.issueId);
      else {
        if (isReopen)
          cycleStartedAt.delete(event.issueId);
        const enteredWork = working(after) && (
          event.kind === 'created' || before !== null && !working(before)
        );
        if (enteredWork && !cycleStartedAt.has(event.issueId))
          cycleStartedAt.set(event.issueId, at);
      }
      if (at > generated || at < rangeStart || at >= rangeEnd || event.kind === 'baseline' || event.kind === 'restored')
        return;
      const day = local.day(at);
      const reportDay = dayMap.get(day);
      const eventState = event.kind === 'deleted' || event.kind === 'moved_out' ? before : after;
      if (!reportDay || !matches(eventState))
        return;
      const issueMetric = ensureIssueMetric(eventState);
      if (follows(latestMetricEvent.get(event.issueId), at, event.sequence)) {
        issueMetric.issue = structuredClone(eventState);
        latestMetricEvent.set(event.issueId, { at, sequence: event.sequence });
      }
      if (event.kind === 'created') {
        period.created++;
        reportDay.created++;
      }
      if (event.kind === 'deleted')
        period.deleted++;
      if (event.kind === 'reclassified')
        period.reclassified++;
      if (isCompletion) {
        period.completionTransitions++;
        reportDay.completed++;
        completedIssueIds.add(event.issueId);
        issueMetric.completed++;
        if (follows(latestCompletion.get(event.issueId), at, event.sequence)) {
          issueMetric.lastCompletedAt = event.occurredAt;
          issueMetric.cycleHours = cycle;
          latestCompletion.set(event.issueId, { at, sequence: event.sequence });
        }
        if (cycle !== null && cycle >= 0)
          cycleSamplesHours.push(cycle);
      }
      if (isReopen) {
        period.reopened++;
        reportDay.reopened++;
        issueMetric.reopened++;
      }
    };
    // Current-state ages run through capture time even for a past date range.
    const observedUntil = epoch === currentEpoch ? generated : Math.min(generated, rangeEnd);
    for (const request of snapshotRequests) {
      const belongsToSnapshot = (at: number) => request.inclusive
        ? at <= request.at
        : at < request.at;
      while (eventCursor < epoch.events.length && belongsToSnapshot(epoch.events[eventCursor].at)) {
        const event = epoch.events[eventCursor++];
        if (event.at <= generated && event.at < rangeEnd)
          applyObservedEvent(event);
      }
      request.output.state = { ...snapshotCounts };
    }
    while (eventCursor < epoch.events.length && epoch.events[eventCursor].at <= observedUntil) {
      const event = epoch.events[eventCursor++];
      if (event.at < rangeEnd || epoch === currentEpoch)
        applyObservedEvent(event);
    }
    if (epoch === currentEpoch) {
      for (const issue of current) {
        const enteredAt = statusEnteredAt.get(issue.issueId);
        if (enteredAt !== undefined && sameStatus(knownStates.get(issue.issueId), issue))
          openStatusEntries.set(issue.issueId, enteredAt);
      }
    }
  }
  period.completedIssues = completedIssueIds.size;
  period.repeatedCompletions = period.completionTransitions - completedIssueIds.size;
  period.cycleSamples = cycleSamplesHours.length;
  period.medianCycleHours = medianSortedHours(cycleSamplesHours.sort((a, b) => a - b));
  const completedVisits = [...statusVisits].map(([statusId, visits]): ReportStatusVisitMetric => {
    const hours = visits.hours.sort((a, b) => a - b);
    return {
      statusId, statusLabel: visits.state.statusLabel, category: visits.state.category,
      samples: hours.length, unknownEntries: visits.unknownEntries,
      medianHours: medianSortedHours(hours), maxHours: hours.at(-1) ?? null,
    };
  }).sort((a, b) => (b.medianHours ?? -1) - (a.medianHours ?? -1) || a.statusLabel.localeCompare(b.statusLabel) || a.statusId.localeCompare(b.statusId));
  const openIssues = current.filter(issue => !terminal(issue)).map((issue): ReportOpenStatusIssue => {
    const { issueId, key, title, statusId, statusLabel, category, assigneeId } = issue;
    const enteredAt = openStatusEntries.get(issueId);
    return {
      issueId, key, title, statusId, statusLabel, category, assigneeId,
      enteredAt: enteredAt === undefined ? null : new Date(enteredAt).toISOString(),
      elapsedHours: enteredAt === undefined ? null : (generated - enteredAt) / HOUR,
    };
  }).sort((a, b) => (b.elapsedHours ?? -1) - (a.elapsedHours ?? -1) || a.key.localeCompare(b.key) || a.issueId.localeCompare(b.issueId));
  const coverage = epochs.filter(epoch =>
    epoch.start <= generated && epoch.start < rangeEnd && epoch.end >= rangeStart &&
    Math.min(epoch.end, generated, rangeEnd) >= rangeStart
  );
  const observed = coverage
    .map(epoch => Math.min(epoch.end, generated, rangeEnd))
    .filter(at => at >= rangeStart);
  const issues = [...issueMetrics.values()].sort((a, b) =>
    b.completed - a.completed ||
    b.reopened - a.reopened ||
    (latestCompletion.get(b.issue.issueId)?.at ?? -Infinity) -
      (latestCompletion.get(a.issue.issueId)?.at ?? -Infinity) ||
    a.issue.key.localeCompare(b.issue.key) ||
    a.issue.issueId.localeCompare(b.issue.issueId)
  );
  return {
    definitionVersion: 2,
    query,
    generatedAt: input.generatedAt,
    rangeStartAt: new Date(rangeStart).toISOString(),
    rangeEndAt: new Date(rangeEnd).toISOString(),
    observedThrough: observed.length ? new Date(Math.max(...observed)).toISOString() : null,
    coverage: coverage.map(epoch => epoch.coverage),
    current: { total: current.length, state: currentState, overdue, dueSoon },
    period,
    statusDuration: { completedVisits, openIssues },
    days: days.map(value => value.output),
    issues
  };
}
