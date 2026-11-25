import { calendarDate, calendarDay, isCalendarDate, MAX_CALENDAR_DATE, MIN_CALENDAR_DATE } from './calendar.js';
import type { Issue, Milestone } from './types.js';

const dateFields = ['startDate', 'endDate', 'dueDate'] as const;
export type GanttCalendarField = typeof dateFields[number];
export type GanttCalendarEntry =
  | { kind: 'issue'; issue: Issue; fields: GanttCalendarField[] }
  | { kind: 'milestone'; milestone: Milestone };

const firstSupportedDay = calendarDay(MIN_CALENDAR_DATE);
const lastSupportedDay = calendarDay(MAX_CALENDAR_DATE);

export function ganttCalendarWeekday(date: string) {
  return ((calendarDay(date) + 3) % 7 + 7) % 7;
}

export function shiftGanttCalendarDay(date: string, offset: number) {
  const day = calendarDay(date) + offset;
  return calendarDate(Math.min(lastSupportedDay, Math.max(firstSupportedDay, day)));
}

export function shiftGanttCalendarMonth(date: string, offset: number) {
  const index = Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1 + offset;
  if (index < 0 || index >= 120_000) return null;
  const year = String(Math.floor(index / 12)).padStart(4, '0');
  const month = String(index % 12 + 1).padStart(2, '0');
  const start = `${year}-${month}-01`;
  const day = Math.min(Number(date.slice(8, 10)), ganttCalendarMonthLength(start));
  return `${year}-${month}-${String(day).padStart(2, '0')}`;
}

function ganttCalendarMonthLength(firstOfMonth: string) {
  const lastOfMonth = new Date(`${firstOfMonth}T00:00:00Z`);
  lastOfMonth.setUTCMonth(lastOfMonth.getUTCMonth() + 1, 0);
  return lastOfMonth.getUTCDate();
}

export function buildGanttMonthCalendar(date: string, issues: readonly Issue[], milestones: readonly Milestone[]) {
  const month = date.slice(0, 7);
  const firstOfMonth = `${month}-01`;
  const firstDay = calendarDay(firstOfMonth);
  const length = ganttCalendarMonthLength(firstOfMonth);
  const days = Array.from({ length }, (_, index) => calendarDate(firstDay + index));
  const entries = new Map<string, GanttCalendarEntry[]>(days.map(day => [day, []]));

  for (const issue of issues) {
    const byDate = new Map<string, GanttCalendarField[]>();
    for (const field of dateFields) {
      const value = issue[field];
      if (!isCalendarDate(value) || !entries.has(value)) continue;
      const fields = byDate.get(value);
      if (fields) fields.push(field);
      else byDate.set(value, [field]);
    }
    for (const [day, fields] of byDate) entries.get(day)!.push({ kind: 'issue', issue, fields });
  }
  for (const milestone of milestones) entries.get(milestone.date)?.push({ kind: 'milestone', milestone });

  return { days, leading: ganttCalendarWeekday(firstOfMonth), entries };
}
