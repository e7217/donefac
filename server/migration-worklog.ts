import type { LegacyRecord, LegacyValue } from '../shared/types.js';
import { isCalendarDate } from '../shared/calendar.js';
import { uniqueWallTimeInstant, utcTime, wallTimeFormatter } from '../shared/wall-time.js';

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
export function jiraWorklogRestrictionAttribute(name: string): string | null {
  const normalized = name.replace(/[\s_-]/g, '').toLowerCase();
  return restrictionNames.has(normalized) ? normalized : null;
}

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
    ([name, value]) => jiraWorklogRestrictionAttribute(name) !== null && nonempty(value),
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

function start(row: LegacyRecord, timeZone: string): { workDate: string; startedAt: string | null } | JiraWorklogProblem {
  let raw: LegacyValue | undefined;
  for (const name of ['started', 'startDate', 'startdate']) {
    if (Object.hasOwn(row.metadata, name)) { raw = row.metadata[name]; break; }
  }
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 100) {
    return problem('WORKLOG_START_INVALID', '작업 시작 날짜(started/startDate/startdate)가 없거나 올바르지 않습니다.');
  }
  const value = raw.trim();
  const formatter = wallTimeFormatter(timeZone);
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
    instant = uniqueWallTimeInstant(naive, match[1], timeZone, formatter);
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
