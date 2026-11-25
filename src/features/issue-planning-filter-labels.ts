import type { IssueViewPlanningFilter, PlanningItem, PlanningKind } from '../../shared/types';
import { PLAN_ID_FIELDS, PLAN_LABELS } from './PlanningSelectors';

export const ISSUE_FILTER_PLAN_KINDS: readonly PlanningKind[] = ['cycle', 'module', 'release'];

export const ISSUE_FILTER_DATE_LABELS = {
  all: '모든 일정',
  planned: '일정 입력 완료',
  needs_dates: '일정 미정',
  overlap: '계획 기간 겹침',
  due: '목표 마감일 범위',
  due_relative: '오늘 기준 목표 마감일',
  due_set: '목표 마감일 있음',
  due_missing: '목표 마감일 없음',
} as const;

function dayLabel(days: number): string {
  if (days === 0) return '오늘';
  return `${Math.abs(days)}일 ${days < 0 ? '전' : '후'}`;
}

function rangeLabel(from: string | undefined, to: string | undefined): string {
  if (from && to) return `${from}부터 ${to}까지`;
  if (from) return `${from}부터`;
  return to ? `${to}까지` : '';
}

export function planningFilterItemLabel(item?: PlanningItem): string {
  return item ? `${item.name}${item.status === 'archived' ? ' (보관됨)' : ''}` : '현재 항목 없음';
}

export function issuePlanningFilterLabels(filter: IssueViewPlanningFilter | undefined, planningItems: readonly PlanningItem[]): string[] {
  if (!filter) return [];
  const labels: string[] = [];
  for (const kind of ISSUE_FILTER_PLAN_KINDS) {
    const id = filter[PLAN_ID_FIELDS[kind]];
    if (id === undefined) continue;
    const label = PLAN_LABELS[kind];
    if (id === null) {
      labels.push(`${label} 미지정`);
    } else {
      const item = planningItems.find(value => value.id === id && value.kind === kind);
      labels.push(`${label} · ${planningFilterItemLabel(item)}`);
    }
  }
  const release = filter.releaseFilter;
  if (release?.kind === 'assigned') {
    labels.push('릴리스 지정됨');
  } else if (release?.kind === 'any') {
    const names = release.ids.map(id => planningFilterItemLabel(planningItems.find(item => item.id === id && item.kind === 'release')));
    labels.push(`릴리스 · ${names.join(', ')}`);
  }
  const dates = filter.dates;
  if (!dates) return labels;
  if (dates.mode === 'due_relative') {
    const range = rangeLabel(dates.fromDays === undefined ? undefined : dayLabel(dates.fromDays),
      dates.toDays === undefined ? undefined : dayLabel(dates.toDays));
    const fixed = rangeLabel(dates.from, dates.to);
    labels.push(`목표 마감일 · ${range} (서울 기준)${fixed ? ` · 고정 ${fixed}` : ''}`);
  } else if (dates.mode === 'overlap' || dates.mode === 'due') {
    const label = dates.mode === 'due' ? '목표 마감일' : ISSUE_FILTER_DATE_LABELS.overlap;
    const range = dates.from && dates.to ? `${dates.from} ~ ${dates.to}` : dates.from ? `${dates.from}부터` : `${dates.to}까지`;
    labels.push(`${label} · ${range}`);
  } else {
    labels.push(ISSUE_FILTER_DATE_LABELS[dates.mode]);
  }
  return labels;
}
