import { DEPENDENCY_LABELS } from '../../shared/schedule-dependencies';
import type { Dependency, Issue } from '../../shared/types';

export const DAY_MS = 86_400_000;
export function dayNumber(date: string) { return Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS); }
export function isoDay(day: number) { return new Date(day * DAY_MS).toISOString().slice(0, 10); }
export function todayDate() {
  const today = new Date();
  return `${String(today.getFullYear()).padStart(4, '0')}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
}
export function moveDate(date: string, days: number) { return isoDay(dayNumber(date) + days); }
export function scheduleRange(issues: Issue[]) {
  const today = dayNumber(todayDate());
  const dates = issues.flatMap(i => [i.startDate, i.endDate]).filter((date): date is string => Boolean(date)).map(dayNumber).filter(Number.isFinite);
  const start = Math.min(today - 7, ...dates) - 2;
  const end = Math.max(today + 35, ...dates) + 3;
  return { start, end, days: end - start + 1 };
}
export function errorMessage(error: unknown) { return error instanceof Error ? error.message : '요청을 처리하지 못했습니다.'; }

export function dependencyLabel(dependency: Pick<Dependency, 'type' | 'lagDays'>) {
  const { type = 'FS', lagDays } = dependency;
  return `${DEPENDENCY_LABELS[type]} (${type}) · ${lagDays > 0 ? '+' : ''}${lagDays}근무일`;
}
