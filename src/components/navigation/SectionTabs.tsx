import type { PointerEventHandler } from 'react';
import { cn } from '@/src/lib/utils';
import { scrollEdgeMask, useScrollEdges } from './use-scroll-edges';
import type { NavGroup, NavTab, NavTabId } from './nav-groups';

/** Height of the tab bar including its bottom border; pages sized to the viewport subtract it. */
export const SECTION_TABS_HEIGHT = 40;

type SectionTabsProps = {
  group: NavGroup;
  activeTab: NavTabId;
  onSelect: (tab: NavTabId) => void;
  isDisabled?: (tab: NavTab) => boolean;
  /** Tabs that leave or enter a gantt keep a focused gantt date input from blurring first. */
  keepsGanttFocus?: (tab: NavTab) => boolean;
  onGanttPointerDown?: PointerEventHandler<HTMLButtonElement>;
};

/**
 * Route links between the views of one navigation group. These are page
 * navigations, not ARIA tabs: the active page is marked with aria-current.
 */
export function SectionTabs({ group, activeTab, onSelect, isDisabled, keepsGanttFocus, onGanttPointerDown }: SectionTabsProps) {
  const { ref, edges } = useScrollEdges<HTMLElement>(group.id);
  return <nav ref={ref} aria-label={`${group.label} 화면`} data-nav-group={group.id}
    className={cn("flex h-10 min-w-0 items-stretch gap-1 overflow-x-auto overflow-y-hidden overscroll-x-contain border-b border-border-subtle bg-surface-1 px-7 [scrollbar-width:thin] max-[1150px]:px-4 max-[680px]:px-2", scrollEdgeMask(edges))}>
    {group.tabs.map(tab => {
      const active = tab.id === activeTab;
      const ganttFocus = keepsGanttFocus?.(tab) ?? false;
      return <button key={tab.id} type="button" aria-current={active ? 'page' : undefined} disabled={isDisabled?.(tab)}
        data-gantt-focus-control={ganttFocus ? '' : undefined} onPointerDown={ganttFocus ? onGanttPointerDown : undefined}
        onClick={() => onSelect(tab.id)}
        className={cn(
          'relative inline-flex shrink-0 items-center whitespace-nowrap rounded-none px-2.5 text-sm text-fg-tertiary transition-colors',
          'hover:text-fg-primary focus-visible:-outline-offset-2',
          'after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-transparent',
          active && 'font-semibold text-fg-primary after:bg-brand',
        )}>{tab.label}</button>;
    })}
  </nav>;
}
