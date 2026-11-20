const HOUR_MS = 3_600_000;
const formatters = new Map<string, Intl.DateTimeFormat>();
const offsetCache = new Map<string, number[]>();

export function utcTime(year: number, month: number, day: number, hour: number, minute: number, second: number, millis = 0): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millis);
  return date.getTime();
}

export function wallTimeFormatter(timeZone: string): Intl.DateTimeFormat | null {
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

export function wallTime(formatter: Intl.DateTimeFormat, at: number): number {
  const parts = Object.fromEntries(formatter.formatToParts(at).map(part => [part.type, part.value]));
  const year = parts.era === 'BC' ? 1 - Number(parts.year) : Number(parts.year);
  return utcTime(year, Number(parts.month), Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
}

export function wallTimeCandidates(naive: number, date: string, timeZone: string, formatter: Intl.DateTimeFormat): number[] {
  const cacheKey = `${timeZone}:${date}`;
  let offsets = offsetCache.get(cacheKey);
  if (!offsets) {
    const midnight = Date.parse(`${date}T00:00:00Z`);
    const observed = new Set<number>();
    // Consider both sides of an offset transition before checking the requested wall time.
    for (let sample = midnight - 48 * HOUR_MS; sample <= midnight + 48 * HOUR_MS; sample += 6 * HOUR_MS) {
      observed.add(wallTime(formatter, sample) - sample);
    }
    offsets = [...observed];
    offsetCache.set(cacheKey, offsets);
    if (offsetCache.size > 512) offsetCache.delete(offsetCache.keys().next().value!);
  }
  const wholeSecond = Math.floor(naive / 1000) * 1000;
  return offsets.map(offset => naive - offset).filter(at => wallTime(formatter, at) === wholeSecond);
}

export function uniqueWallTimeInstant(naive: number, date: string, timeZone: string, formatter: Intl.DateTimeFormat): number | null {
  const matches = wallTimeCandidates(naive, date, timeZone, formatter);
  return matches.length === 1 ? matches[0] : null;
}
