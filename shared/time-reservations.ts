import { isCalendarDate } from './calendar.js';
import { uniqueWallTimeInstant, wallTime, wallTimeCandidates, wallTimeFormatter } from './wall-time.js';

export const DEFAULT_RESERVATION_TIME_ZONE = 'Asia/Seoul';
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const LOCAL_MINUTE = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/;

function instantISO(value: number): string | null {
  const formatted = new Date(value).toISOString();
  return formatted.length === 24 && formatted.endsWith(':00.000Z') ? formatted : null;
}

export function reservationLocalDateTime(instant: string, timeZone = DEFAULT_RESERVATION_TIME_ZONE): string {
  const at = Date.parse(instant);
  const formatter = wallTimeFormatter(timeZone);
  if (!Number.isFinite(at) || !formatter) return '';
  const localTime = wallTime(formatter, at);
  if (!Number.isFinite(localTime)) return '';
  const display = new Date(localTime).toISOString().slice(0, 16);
  return LOCAL_MINUTE.test(display) ? display : '';
}

export function reservationInstant(localDateTime: string, timeZone = DEFAULT_RESERVATION_TIME_ZONE): string | null {
  if (!LOCAL_MINUTE.test(localDateTime)) return null;
  const date = localDateTime.slice(0, 10);
  const formatter = wallTimeFormatter(timeZone);
  if (!isCalendarDate(date) || !formatter) return null;
  const at = uniqueWallTimeInstant(Date.parse(`${localDateTime}:00Z`), date, timeZone, formatter);
  return at === null ? null : instantISO(at);
}

function dayBoundary(date: string, timeZone: string, formatter: Intl.DateTimeFormat): number | null {
  const midnight = Date.parse(`${date}T00:00:00Z`);
  const candidates = wallTimeCandidates(midnight, date, timeZone, formatter);
  if (candidates.length) return Math.ceil(Math.min(...candidates) / MINUTE_MS) * MINUTE_MS;

  // If a transition skips local midnight, use the first representable minute of the day.
  for (let end = midnight - 2 * DAY_MS + HOUR_MS; end <= midnight + 2 * DAY_MS; end += HOUR_MS) {
    let low = (end - HOUR_MS) / MINUTE_MS;
    let high = end / MINUTE_MS;
    if (wallTime(formatter, low * MINUTE_MS) >= midnight || wallTime(formatter, end) < midnight) continue;
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (wallTime(formatter, middle * MINUTE_MS) < midnight) low = middle;
      else high = middle;
    }
    return high * MINUTE_MS;
  }
  return null;
}

export function reservationDayRange(date: string, timeZone = DEFAULT_RESERVATION_TIME_ZONE): {startAt: string; endAt: string} | null {
  if (!isCalendarDate(date)) return null;
  const formatter = wallTimeFormatter(timeZone);
  const nextDate = new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
  if (!formatter || !isCalendarDate(nextDate)) return null;
  const start = dayBoundary(date, timeZone, formatter);
  const end = dayBoundary(nextDate, timeZone, formatter);
  if (start === null || end === null || start >= end) return null;
  const startAt = instantISO(start), endAt = instantISO(end);
  return startAt && endAt ? {startAt, endAt} : null;
}
