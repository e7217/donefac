'use client';

import { useState, type MouseEvent } from 'react';
import './document-outline.css';

export type DocumentOutlineEntry<Target extends string | number = string> = {
  target: Target;
  level: number;
  title: string;
};

export function outlineHeadingTitle(text: string): string {
  return text.trim().replace(/\s+/gu, ' ').replace(/^(.{240}).+$/u, '$1…');
}

export function jumpToDocumentHeading(heading: HTMLElement, contentRoot: HTMLElement, moveFocus = false) {
  if (!contentRoot.contains(heading)) return;
  for (let parent = heading.parentElement; parent && parent !== contentRoot; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
  }
  heading.scrollIntoView({ block: 'center', inline: 'nearest' });
  if (moveFocus) heading.focus({ preventScroll: true });
}

function OutlineEntries<Target extends string | number>({ entries, onNavigate, onMouseDown }: {
  entries: DocumentOutlineEntry<Target>[];
  onNavigate: (target: Target) => void;
  onMouseDown?: (event: MouseEvent<HTMLElement>) => void;
}) {
  const titleCounts = new Map<string, number>();
  for (const { title } of entries) titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
  const occurrences = new Map<string, number>();
  return <nav className="document-outline-navigation" aria-label="문서 제목">
    <ol className="document-outline-entries" role="list">
      {entries.map(({ target, level, title }) => {
        const occurrence = (occurrences.get(title) ?? 0) + 1;
        const total = titleCounts.get(title) ?? 1;
        occurrences.set(title, occurrence);
        return <li key={target} data-heading-level={level}>
          <button className="document-outline-entry" type="button" onMouseDown={onMouseDown} onClick={() => onNavigate(target)}>
            {title}{total > 1 && ` (${occurrence}/${total})`}
          </button>
        </li>;
      })}
    </ol>
  </nav>;
}

export function DocumentOutline<Target extends string | number>({ entries, onNavigate, preservePointerSelection = false }: {
  entries: DocumentOutlineEntry<Target>[];
  onNavigate: (target: Target) => void;
  preservePointerSelection?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!entries.length) return null;
  const onMouseDown = preservePointerSelection ? (event: MouseEvent<HTMLElement>) => event.preventDefault() : undefined;
  return <details className="document-outline" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary className="document-outline-summary" onMouseDown={onMouseDown}>문서 목차</summary>
    {expanded && <OutlineEntries entries={entries} onNavigate={onNavigate} onMouseDown={onMouseDown} />}
  </details>;
}
