import { isCalendarDate } from '../../shared/calendar';

export type GanttZoom = 'day' | 'week' | 'month';
export type GanttTimelineLink = {
  date: string;
  zoom: GanttZoom;
  hideDone?: boolean;
  search?: string;
  plansOpen?: boolean;
  linkedOnly?: boolean;
};

export function appendGanttTimelineLink(query: URLSearchParams, link: GanttTimelineLink) {
  query.set('ganttDate', link.date);
  query.set('ganttScale', link.zoom);
  if (link.hideDone) query.set('ganttHideDone', '1');
  if (link.search) query.set('ganttSearch', link.search);
  if (link.plansOpen) query.set('ganttPlans', '1');
  if (link.linkedOnly) query.set('ganttLinked', '1');
}

export function readGanttTimelineLink(query: URLSearchParams, projectScope: boolean, hasPlan: boolean): GanttTimelineLink | undefined {
  const date = query.get('ganttDate');
  const zoom = query.get('ganttScale');
  if (!isCalendarDate(date) || (zoom !== 'day' && zoom !== 'week' && zoom !== 'month')) return;
  const search = projectScope ? query.get('ganttSearch')?.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200).toWellFormed() : undefined;
  return {
    date, zoom, hideDone: query.get('ganttHideDone') === '1',
    search: search || undefined,
    plansOpen: projectScope && query.get('ganttPlans') === '1',
    linkedOnly: projectScope && hasPlan && query.get('ganttLinked') === '1',
  };
}

export function ganttTimelineLinkKey(link?: GanttTimelineLink) {
  return link ? JSON.stringify([link.date, link.zoom, Boolean(link.hideDone), link.search || '', Boolean(link.plansOpen), Boolean(link.linkedOnly)]) : '';
}
