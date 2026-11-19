import type { LegacyRecord, LegacyValue } from '../shared/types.js';
import { isCalendarDate } from '../shared/calendar.js';

export interface ParsedJiraWorklog {
  workDate: string;
  durationSeconds: number;
  startedAt: string | null;
}
export interface JiraWorklogProblem { code: string; message: string }

export const MAX_JIRA_WORKLOG_SECONDS = 2_147_483_647;

// REST seconds are authoritative; Importers JSON uses ISO periods. Jira's
// configurable working day/week prevents inferring seconds from d/w units.
// https://developer.atlassian.com/server/jira/platform/rest/v11003/api-group-issue/
// https://confluence.atlassian.com/servicedeskcloud/importing-data-from-json-1097176631.html
// https://support.atlassian.com/jira-cloud-administration/docs/configure-time-tracking/
const restrictionNames = new Set([
  'visibility', 'role', 'roleid', 'rolekey', 'rolelevel', 'group', 'groupid',
  'groupkey', 'groupname', 'grouplevel', 'restriction', 'restrictions',
  'restricted', 'isrestricted', 'hasrestrictions', 'restrictiontype',
  'restrictionvalue', 'viewrole', 'viewrolelevel', 'viewgroup', 'viewgrouplevel',
  'permissions',
]);
const attributeName = (name: string) => name.replace(/[\s_-]/g, '').toLowerCase();

export function isJiraWorklog(row: LegacyRecord): boolean {
  return row.kind === 'history' && row.metadata.kind === 'worklog';
}

function nonempty(value: LegacyValue): boolean {
  if (value === null || value === false) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return true;
  if (Array.isArray(value)) return value.some(nonempty);
  if (typeof value === 'object') return Object.values(value).some(nonempty);
  return true;
}

export function isRestrictedJiraWorklog(row: LegacyRecord): boolean {
  return isJiraWorklog(row) && Object.entries(row.metadata).some(
    ([name, value]) => restrictionNames.has(attributeName(name)) && nonempty(value),
  );
}

const problem = (code: string, message: string): JiraWorklogProblem => ({ code, message });
const durationProblem = () => problem('WORKLOG_DURATION_INVALID', '작업 시간은 1~2,147,483,647 사이의 정수 초여야 합니다. 숫자 초 또는 명시적인 시간·분·초 단위를 확인해 주세요.');

function numericSeconds(value: LegacyValue): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 && value <= MAX_JIRA_WORKLOG_SECONDS ? value : null;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim()) || value.trim().length > 20) return null;
  const seconds = Number(value.trim());
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= MAX_JIRA_WORKLOG_SECONDS ? seconds : null;
}

function textSeconds(value: LegacyValue): number | JiraWorklogProblem {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000) return durationProblem();
  const source = value.trim();
  if ((/^P/i.test(source) && /[DWY]|^P[^T]*M/i.test(source)) || /\d\s*(?:days?|d|weeks?|w)\b/i.test(source)) {
    return problem('WORKLOG_DURATION_AMBIGUOUS', '일·주·월·년 단위 작업 시간은 원본 Jira의 근무 시간 설정 없이 초로 확정할 수 없습니다. 숫자 초 또는 시간·분·초가 필요합니다.');
  }
  let components: { value: string; multiplier: number }[];
  if (source.startsWith('P')) {
    const match = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(source);
    if (!match || !match.slice(1).some(Boolean)) return durationProblem();
    components = match.slice(1).flatMap((part, index) => part ? [{ value: part, multiplier: [3600, 60, 1][index] }] : []);
  } else {
    components = [];
    const units = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?=\s|\d|$)/iy;
    let index = 0;
    while (index < source.length) {
      while (/\s/.test(source[index] || '') && index < source.length) index++;
      if (index === source.length) break;
      units.lastIndex = index;
      const match = units.exec(source);
      if (!match) return durationProblem();
      components.push({ value: match[1], multiplier: /^h/i.test(match[2]) ? 3600 : /^m/i.test(match[2]) ? 60 : 1 });
      index = units.lastIndex;
    }
    if (!components.length) return durationProblem();
  }
  // Sum exact decimal fractions before checking whole seconds. Floating-point
  // rounding must never turn 0.1 seconds into a valid imported integer.
  const precision = Math.max(...components.map(component => component.value.split('.')[1]?.length || 0));
  const denominator = BigInt(10) ** BigInt(precision);
  let numerator = BigInt(0);
  for (const component of components) {
    const [integer, fraction = ''] = component.value.split('.');
    numerator += BigInt(integer + fraction) * (BigInt(10) ** BigInt(precision - fraction.length)) * BigInt(component.multiplier);
    if (numerator > BigInt(MAX_JIRA_WORKLOG_SECONDS) * denominator) return durationProblem();
  }
  if (numerator % denominator !== BigInt(0)) return durationProblem();
  const seconds = numerator / denominator;
  return seconds > BigInt(0) ? Number(seconds) : durationProblem();
}

function duration(row: LegacyRecord): number | JiraWorklogProblem {
  for (const name of ['timeSpentSeconds', 'timeworked']) {
    if (Object.hasOwn(row.metadata, name)) return numericSeconds(row.metadata[name]) ?? durationProblem();
  }
  return textSeconds(row.metadata.timeSpent);
}

function utcTime(year: number, month: number, day: number, hour: number, minute: number, second: number, millis = 0): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millis);
  return date.getTime();
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const offsetCache = new Map<string, number[]>();
function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  if (typeof timeZone !== 'string' || !timeZone || timeZone.trim() !== timeZone || timeZone.length > 100 || /^[+-]/.test(timeZone)) return null;
  const existing = formatters.get(timeZone);
  if (existing) return existing;
  try {
    const formatter = new Intl.DateTimeFormat('en-GB-u-ca-gregory-nu-latn', {
      timeZone, era: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    formatter.format(0);
    formatters.set(timeZone, formatter);
    if (formatters.size > 16) formatters.delete(formatters.keys().next().value!);
    return formatter;
  } catch { return null; }
}

function wallTime(formatter: Intl.DateTimeFormat, at: number): number {
  const parts = Object.fromEntries(formatter.formatToParts(at).map(part => [part.type, part.value]));
  const year = parts.era === 'BC' ? 1 - Number(parts.year) : Number(parts.year);
  return utcTime(year, Number(parts.month), Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
}

function localInstant(naive: number, date: string, timeZone: string, formatter: Intl.DateTimeFormat): number | null {
  const cacheKey = `${timeZone}:${date}`;
  let offsets = offsetCache.get(cacheKey);
  if (!offsets) {
    const midnight = Date.parse(`${date}T00:00:00Z`);
    const observed = new Set<number>();
    // Both sides of DST/date-line changes are considered. A gap has no match;
    // a repeated local time has two matches and is never silently disambiguated.
    for (let sample = midnight - 48 * 3600000; sample <= midnight + 48 * 3600000; sample += 6 * 3600000) {
      observed.add(wallTime(formatter, sample) - sample);
    }
    offsets = [...observed];
    offsetCache.set(cacheKey, offsets);
    if (offsetCache.size > 512) offsetCache.delete(offsetCache.keys().next().value!);
  }
  const wholeSecond = Math.floor(naive / 1000) * 1000;
  const matches = offsets.map(offset => naive - offset).filter(at => wallTime(formatter, at) === wholeSecond);
  return matches.length === 1 ? matches[0] : null;
}

function start(row: LegacyRecord, timeZone: string): { workDate: string; startedAt: string | null } | JiraWorklogProblem {
  let raw: LegacyValue | undefined;
  for (const name of ['started', 'startDate', 'startdate']) {
    if (Object.hasOwn(row.metadata, name)) { raw = row.metadata[name]; break; }
  }
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 100) {
    return problem('WORKLOG_START_INVALID', '작업 시작 날짜(started/startDate/startdate)가 없거나 올바르지 않습니다.');
  }
  const value = raw.trim();
  const formatter = formatterFor(timeZone);
  if (!formatter) return problem('WORKLOG_START_INVALID', '작업 시작 시각을 해석할 유효한 IANA 시간대가 필요합니다.');
  // A written date supplies a calendar day, not an invented midnight instant.
  if (isCalendarDate(value)) return { workDate: value, startedAt: null };
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(value);
  if (!match || !isCalendarDate(match[1])) return problem('WORKLOG_START_INVALID', '작업 시작일은 절대 날짜 또는 유효한 ISO 날짜·시각이어야 합니다. 상대 날짜는 해석하지 않습니다.');
  const [year, month, day] = match[1].split('-').map(Number);
  const hour = Number(match[2]), minute = Number(match[3]), second = Number(match[4] || 0);
  if (hour > 23 || minute > 59 || second > 59) return problem('WORKLOG_START_INVALID', '작업 시작 시각의 시·분·초 범위를 확인해 주세요.');
  const naive = utcTime(year, month, day, hour, minute, second, Number((match[5] || '').padEnd(3, '0')));
  let instant: number | null;
  if (match[6]) {
    const offset = match[6];
    if (offset === 'Z') instant = naive;
    else {
      const hours = Number(offset.slice(1, 3)), minutes = Number(offset.slice(-2));
      if (hours > 23 || minutes > 59) return problem('WORKLOG_START_INVALID', '작업 시작 시각의 UTC 오프셋 범위를 확인해 주세요.');
      instant = naive - (offset.startsWith('-') ? -1 : 1) * (hours * 60 + minutes) * 60000;
    }
  } else {
    instant = localInstant(naive, match[1], timeZone, formatter);
  }
  if (instant === null) return problem('WORKLOG_START_INVALID', '지정 시간대에서 작업 시작 시각이 없거나 두 번 발생합니다. 명시적인 UTC 오프셋이 필요합니다.');
  return { workDate: match[1], startedAt: new Date(instant).toISOString() };
}

export function parseJiraWorklog(row: LegacyRecord, timeZone: string): ParsedJiraWorklog | JiraWorklogProblem {
  if (!isJiraWorklog(row)) return problem('WORKLOG_RECORD_INVALID', 'Jira 작업 시간 기록 객체가 아닙니다.');
  const durationSeconds = duration(row);
  if (typeof durationSeconds !== 'number') return durationSeconds;
  const started = start(row, timeZone);
  return 'code' in started ? started : { ...started, durationSeconds };
}
