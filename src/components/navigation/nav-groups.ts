/**
 * Sidebar groups and the tab bar under the topbar. Routes and views are
 * unchanged: a tab is only a presentation of an existing view (plus the team
 * scope of gantt and decision follow-ups).
 */
export type NavGroupId = 'team' | 'work' | 'cycle' | 'docs';
export type NavTabId = 'teamoverview' | 'teamboard' | 'teamgantt' | 'teamdecisions' |
  'issues' | 'gantt' | 'backlog' | 'planning' | 'documents' | 'publication';
export type NavTab = {
  id: NavTabId;
  label: string;
  /** Team pages that need at least one project, as the sidebar entries did. */
  requiresProject?: boolean;
  /** The tab opens a gantt view. */
  gantt?: boolean;
};
export type NavGroup = { id: NavGroupId; label: string; tabs: readonly NavTab[] };

export const NAV_GROUPS: Readonly<Record<NavGroupId, NavGroup>> = {
  team: { id: 'team', label: '팀 개요', tabs: [
    { id: 'teamoverview', label: '개요' },
    { id: 'teamboard', label: '전체 프로젝트 보드', requiresProject: true },
    { id: 'teamgantt', label: '전체 프로젝트 간트', requiresProject: true, gantt: true },
    { id: 'teamdecisions', label: '팀 결정 후속 업무', requiresProject: true },
  ] },
  work: { id: 'work', label: '업무', tabs: [
    { id: 'issues', label: '목록 · 보드' },
    { id: 'gantt', label: '간트', gantt: true },
  ] },
  cycle: { id: 'cycle', label: '사이클', tabs: [
    { id: 'backlog', label: '백로그 · 사이클 보드' },
    { id: 'planning', label: '사이클 · 모듈 · 릴리스' },
  ] },
  docs: { id: 'docs', label: '문서', tabs: [
    { id: 'documents', label: '문서' },
    { id: 'publication', label: '검토함 · 발행본' },
  ] },
};

export type NavLocation = { view: string; teamGantt: boolean; teamDecisions: boolean };

export function activeNavTab({ view, teamGantt, teamDecisions }: NavLocation): NavTabId | null {
  switch (view) {
    case 'teamoverview': case 'teamboard': case 'issues': case 'backlog': case 'planning': case 'documents': case 'publication':
      return view;
    case 'gantt': return teamGantt ? 'teamgantt' : 'gantt';
    case 'reports': return teamDecisions ? 'teamdecisions' : null;
    default: return null;
  }
}

export function navGroupOf(tab: NavTabId | null): NavGroup | null {
  if (!tab) return null;
  return Object.values(NAV_GROUPS).find(group => group.tabs.some(value => value.id === tab)) ?? null;
}

export function navTab(tab: NavTabId): NavTab {
  for (const group of Object.values(NAV_GROUPS)) {
    const found = group.tabs.find(value => value.id === tab);
    if (found) return found;
  }
  throw new Error(`Unknown navigation tab: ${tab}`);
}

/** Views kept behind the project "더보기" disclosure. */
export type MoreNavView = 'reports' | 'development';
export const MORE_NAV_ITEMS: readonly { id: MoreNavView; label: string }[] = [
  { id: 'reports', label: '보고서' },
  { id: 'development', label: '개발 · GitLab' },
];
export function activeMoreView({ view, teamDecisions }: NavLocation): MoreNavView | null {
  if (view === 'reports' && !teamDecisions) return 'reports';
  if (view === 'development') return 'development';
  return null;
}
