import type { IssueViewPlanningFilter, PlanningItem, PlanningKind } from '../../shared/types';
import { PLAN_ID_FIELDS, PLAN_LABELS } from './PlanningSelectors';

export const ISSUE_FILTER_PLAN_KINDS: readonly PlanningKind[] = ['cycle', 'module', 'release'];

export const ISSUE_FILTER_DATE_LABELS = {
  all: '모든 일정',
  planned: '일정 입력 완료',
  needs_dates: '일정 미정',
  overlap: '계획 기간 겹침',
  due: '목표 마감일 범위',
} as const;

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
      const name = item ? item.name + (item.status === 'archived' ? ' (보관됨)' : '') : '현재 항목 없음';
      labels.push(`${label} · ${name}`);
    }
  }
  const dates = filter.dates;
  if (!dates) return labels;
  if (dates.mode === 'overlap' || dates.mode === 'due') {
    const label = dates.mode === 'due' ? '목표 마감일' : ISSUE_FILTER_DATE_LABELS.overlap;
    const range = dates.from && dates.to ? `${dates.from} ~ ${dates.to}` : dates.from ? `${dates.from}부터` : `${dates.to}까지`;
    labels.push(`${label} · ${range}`);
  } else {
    labels.push(ISSUE_FILTER_DATE_LABELS[dates.mode]);
  }
  return labels;
}
