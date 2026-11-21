import { isCalendarDate } from '../../shared/calendar';
import type { Issue } from '../../shared/types';
import { dayNumber } from './schedule-utils';

export const GANTT_DEADLINE_LABELS = {
  late: '계획 종료일 초과',
  missing: '계획 종료일 미정',
  within: '마감일 이내',
} as const;

export interface GanttDeadline {
  kind: keyof typeof GANTT_DEADLINE_LABELS;
  dueDate: string;
  endDate: string | null;
  delayDays: number | null;
}

export function classifyGanttDeadline({ dueDate, endDate }: Pick<Issue, 'dueDate' | 'endDate'>): GanttDeadline | null {
  if (!isCalendarDate(dueDate)) return null;
  if (!isCalendarDate(endDate)) return { kind: 'missing', dueDate, endDate: null, delayDays: null };
  const delayDays = Math.max(0, dayNumber(endDate) - dayNumber(dueDate));
  return { kind: delayDays ? 'late' : 'within', dueDate, endDate, delayDays };
}
