import { isCalendarDate } from '../shared/calendar.js';

function utcParts(year: number, month: number, day: number, hour = 0, minute = 0, second = 0, millis = 0): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millis);
  return date.getTime();
}

function localDate(value: string, timezone: string): string | null {
  const match = /^(\d{4})-(\d\d)-(\d\d)(?:[ T](\d\d):(\d\d)(?::(\d\d)(?:\.(\d{1,3}))?)?)?$/.exec(value);
  if (!match || !isCalendarDate(value.slice(0, 10))) return null;
  const [year, month, day, hour, minute, second, millis] = [
    Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] || 0),
    Number(match[5] || 0), Number(match[6] || 0), Number((match[7] || '').padEnd(3, '0')),
  ];
  if (hour > 23 || minute > 59 || second > 59) return null;

  const naive = utcParts(year, month, day, hour, minute, second, millis);
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
  const parts = (time: number) => Object.fromEntries(formatter.formatToParts(new Date(time))
    .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  // Check both sides of a clock transition before accepting a local timestamp.
  const offsets = new Set<number>();
  for (const hours of [-36, 0, 36]) {
    const time = naive + hours * 3_600_000;
    const p = parts(time);
    offsets.add(utcParts(p.year, p.month, p.day, p.hour, p.minute, p.second) - Math.floor(time / 1000) * 1000);
  }
  const candidates: number[] = [];
  for (const offset of offsets) {
    const time = naive - offset;
    const p = parts(time);
    if (p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute && p.second === second) {
      candidates.push(time);
    }
  }
  return candidates.length === 1 ? new Date(candidates[0]).toISOString() : null;
}

// An explicit English month avoids guessing the order of numeric locale fields.
// https://confluence.atlassian.com/jirakb/date-format-changes-after-exporting-to-excel-119799961.html
const englishMonths = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export function jiraEnglishDate(value: string): { local: string; century: boolean } | null {
  const match = /^(\d{1,2})\/([A-Za-z]{3})\/(\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:\s+(AM|PM))?)?$/i.exec(value);
  if (!match) return null;
  const month = englishMonths.indexOf(match[2].toLowerCase()) + 1;
  if (!month) return null;
  let hour = Number(match[4] || 0);
  if (match[8]) {
    if (hour < 1 || hour > 12) return null;
    hour = hour % 12 + (match[8].toUpperCase() === 'PM' ? 12 : 0);
  }
  const century = match[3].length === 2;
  const year = century ? 2000 + Number(match[3]) : Number(match[3]);
  const local = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${match[1].padStart(2, '0')} ` +
    `${String(hour).padStart(2, '0')}:${match[5] || '00'}:${match[6] || '00'}${match[7] ? `.${match[7]}` : ''}`;
  return { local, century };
}

export function sourceTimestamp(value: string | null, timezone: string): string | null {
  if (!value) return null;
  const english = jiraEnglishDate(value);
  if (english) return localDate(english.local, timezone);
  if (/(?:Z|[+-]\d\d:?\d\d|\bUTC\b|\bGMT\b)(?:\s*\([^)]*\))?$/.test(value)) {
    if (/^\d{4}-\d\d-\d\d/.test(value) && !isCalendarDate(value.slice(0, 10))) return null;
    const parsed = Date.parse(value.replace(/ UTC$/, 'Z').replace(/^(\d{4}-\d\d-\d\d) /, '$1T'));
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  return localDate(value, timezone);
}
