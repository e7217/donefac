import { useState, type ComponentProps, type PointerEventHandler, type ReactNode } from 'react';
import { BarChart3, BookOpen, CalendarRange, ChevronDown, ChevronRight, CircleDot, ClipboardList, Command, GitBranch, KeyRound,
  LayoutDashboard, ListTodo, MoreHorizontal, Plus, Search, Settings2, Star, Trash2, X, type LucideIcon } from 'lucide-react';
import type { Project } from '@/shared/types';
import { Button } from '@/src/components/ui/button';
import { cn } from '@/src/lib/utils';
import { activeMoreView, activeNavTab, navGroupOf, MORE_NAV_ITEMS, type MoreNavView, type NavGroupId, type NavLocation } from './nav-groups';

export type SidebarView = 'teamoverview' | 'mywork' | 'favorites' | 'trash' | 'settings' | 'overview' | 'intake' | MoreNavView;

type WorkspaceSidebarProps = {
  open: boolean;
  inert: boolean;
  onClose: () => void;
  onOpenSearch: () => void;
  projects: readonly Project[];
  selectedProjectId: string;
  hasProject: boolean;
  location: NavLocation;
  myWorkCount: number;
  issueCount: number;
  environmentLabel: string;
  pilotAccess: boolean;
  onNavigate: (view: SidebarView) => void;
  onOpenGroup: (group: NavGroupId) => void;
  onSelectProject: (id: string) => void;
  onCreateProject: () => void;
  onGanttPointerDown: PointerEventHandler<HTMLButtonElement>;
};

const itemClass = 'nav-item flex min-h-8 w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-base text-fg-secondary transition-colors ' +
  'hover:bg-layer-1-hover hover:text-fg-primary hover:no-underline [&_svg]:text-fg-tertiary';
const activeItemClass = 'bg-selected font-medium text-brand-fg hover:bg-selected-hover hover:text-brand-fg [&_svg]:text-brand-fg';

function NavItem({ icon: Icon, label, active = false, count, className, children, ...props }:
  Omit<ComponentProps<'button'>, 'children'> & { icon: LucideIcon; label: string; active?: boolean; count?: ReactNode; children?: ReactNode }) {
  return <button type="button" aria-current={active ? 'page' : undefined} className={cn(itemClass, active && activeItemClass, className)} {...props}>
    <Icon size={16} aria-hidden="true"/><span className="min-w-0 flex-1 truncate">{label}</span>
    {count !== undefined && <span className="nav-count ml-auto text-xs tabular-nums text-fg-tertiary">{count}</span>}
    {children}
  </button>;
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-between px-2.5 pb-1 text-xs font-semibold tracking-wide text-fg-tertiary">{children}</div>;
}

export function WorkspaceSidebar(props: WorkspaceSidebarProps) {
  const { location, hasProject, onNavigate, onOpenGroup, onGanttPointerDown } = props;
  const ganttView = location.view === 'gantt';
  const group = navGroupOf(activeNavTab(location))?.id ?? null;
  const moreView = activeMoreView(location);
  const [moreOpen, setMoreOpen] = useState(false);
  const [lastMoreView, setLastMoreView] = useState<MoreNavView | null>(null);
  // Opening one of its views expands the disclosure; afterwards the user's toggle is kept.
  if ((moreView ?? null) !== lastMoreView) {
    setLastMoreView(moreView ?? null);
    if (moreView) setMoreOpen(true);
  }
  const moreExpanded = moreOpen;
  const ganttFocus = (enabled: boolean) => ({
    'data-gantt-focus-control': enabled ? '' : undefined,
    onPointerDown: enabled ? onGanttPointerDown : undefined,
  });
  const selectedProject = props.projects.find(project => project.id === props.selectedProjectId);
  return <aside className={cn('sidebar fixed inset-y-0 left-0 z-[35] flex w-[242px] flex-col overflow-y-auto overscroll-y-contain border-r border-border-subtle bg-surface-2 px-3 pt-4 pb-3',
    'max-[1150px]:w-[215px] max-[1150px]:px-2.5 max-[680px]:w-[242px] max-[680px]:transition-transform',
    props.open ? 'is-open' : 'max-[680px]:-translate-x-full')} inert={props.inert}>
    <div className="mb-4 flex items-center gap-2.5 px-1">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand text-fg-on-color"><Command size={18} aria-hidden="true"/></span>
      <div className="min-w-0 flex-1"><strong className="block truncate text-lg font-bold tracking-tight text-fg-primary">Donefac</strong>
        <span className="block truncate text-2xs text-fg-tertiary">함께 만드는 팀의 작업 공간</span></div>
      <Button variant="ghost" size="icon-sm" className="hidden max-[680px]:inline-flex" onClick={props.onClose} aria-label="메뉴 닫기"><X size={18}/></Button>
    </div>
    <button type="button" onClick={props.onOpenSearch}
      className="mb-4 flex h-8 w-full items-center gap-2 rounded-md border border-border-default bg-surface-1 px-2.5 text-sm text-fg-placeholder transition-colors hover:border-border-strong">
      <Search size={15} aria-hidden="true"/><span>업무와 문서 검색</span><kbd className="ml-auto whitespace-nowrap">⌘ K</kbd>
    </button>
    <nav aria-label="워크스페이스" className="mb-5 flex flex-col gap-0.5">
      <NavItem icon={LayoutDashboard} label="팀 개요" active={group === 'team'} {...ganttFocus(ganttView)} onClick={() => onOpenGroup('team')}/>
      <NavItem icon={CircleDot} label="내 업무" active={location.view === 'mywork'} count={props.myWorkCount} onClick={() => onNavigate('mywork')}/>
      <NavItem icon={Star} label="즐겨찾기" active={location.view === 'favorites'} {...ganttFocus(ganttView)} onClick={() => onNavigate('favorites')}/>
    </nav>
    <SectionTitle><span>프로젝트</span>
      <Button variant="ghost" size="icon-sm" className="size-6 text-fg-tertiary" title="프로젝트 만들기" aria-label="프로젝트 만들기" onClick={props.onCreateProject}><Plus size={14}/></Button>
    </SectionTitle>
    <div className="flex flex-col gap-0.5">{props.projects.map(project => {
      const selected = project.id === props.selectedProjectId;
      return <div key={project.id}>
        <button type="button" onClick={() => props.onSelectProject(project.id)}
          className={cn('project-item flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-base text-fg-secondary transition-colors hover:bg-layer-1-hover hover:text-fg-primary',
            selected && 'font-medium text-fg-primary')}>
          <span className="flex size-5 shrink-0 items-center justify-center rounded-sm text-2xs font-bold" style={{ background: project.color + '17', color: project.color }}>{project.key.slice(0, 1)}</span>
          <span className="min-w-0 flex-1 truncate">{project.name}</span>
          {selected && <ChevronDown size={14} aria-hidden="true" className="text-fg-tertiary"/>}
        </button>
        {selected && hasProject && selectedProject && <nav aria-label={`${selectedProject.name} 메뉴`}
          className="project-navigation my-1 ml-[18px] flex flex-col gap-0.5 border-l border-border-subtle pl-2">
          <NavItem icon={LayoutDashboard} label="개요" active={location.view === 'overview'} onClick={() => onNavigate('overview')}/>
          <NavItem icon={ListTodo} label="업무" count={props.issueCount} active={group === 'work'} {...ganttFocus(ganttView)} onClick={() => onOpenGroup('work')}/>
          <NavItem icon={CalendarRange} label="사이클" active={group === 'cycle'} {...ganttFocus(ganttView)} onClick={() => onOpenGroup('cycle')}/>
          <NavItem icon={ClipboardList} label="업무 접수" active={location.view === 'intake'} onClick={() => onNavigate('intake')}/>
          <NavItem icon={BookOpen} label="문서" active={group === 'docs'} {...ganttFocus(ganttView)} onClick={() => onOpenGroup('docs')}/>
          <NavItem icon={MoreHorizontal} label="더보기" aria-expanded={moreExpanded} aria-controls={moreExpanded ? 'project-navigation-more' : undefined}
            aria-current={!moreExpanded && moreView ? 'true' : undefined}
            className={cn(!moreExpanded && moreView && activeItemClass)} onClick={() => setMoreOpen(!moreExpanded)}>
            {moreExpanded ? <ChevronDown size={14} aria-hidden="true"/> : <ChevronRight size={14} aria-hidden="true"/>}
          </NavItem>
          {moreExpanded && <div id="project-navigation-more" className="flex flex-col gap-0.5 pl-3">
            {MORE_NAV_ITEMS.map(item => <NavItem key={item.id} icon={item.id === 'reports' ? BarChart3 : GitBranch} label={item.label}
              active={moreView === item.id} onClick={() => onNavigate(item.id)}/>)}
          </div>}
        </nav>}
      </div>;
    })}</div>
    <div className="mt-auto flex flex-col gap-0.5 pt-5">
      <NavItem icon={Trash2} label="휴지통" active={location.view === 'trash'} onClick={() => onNavigate('trash')}/>
      <NavItem icon={Settings2} label="워크스페이스 설정" active={location.view === 'settings'} onClick={() => onNavigate('settings')}/>
      {props.pilotAccess && <a className={itemClass} href="/pilot-access" target="_blank" rel="noopener noreferrer">
        <KeyRound size={16} aria-hidden="true"/><span className="min-w-0 flex-1 truncate">팀 접속</span></a>}
      <div className="local-status flex items-center gap-1.5 px-2.5 pt-3 text-2xs text-fg-tertiary">
        <span className="size-1.5 shrink-0 rounded-full bg-success" aria-hidden="true"/>{props.environmentLabel}
        <span className="ml-auto">v0.1</span>
      </div>
    </div>
  </aside>;
}
