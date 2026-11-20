'use client';

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Copy, Link2 } from 'lucide-react';
import type { DocumentTocLayout } from '../../shared/document-nodes';
import './document-outline.css';

export type DocumentOutlineEntry<Target extends string | number = string> = {
  target: Target;
  level: number;
  title: string;
  sectionId?: string;
  sectionLinkPending?: boolean;
};

export function jumpToDocumentHeading(heading: HTMLElement, contentRoot: HTMLElement, moveFocus = false) {
  if (!contentRoot.contains(heading)) return;
  for (let parent = heading.parentElement; parent && parent !== contentRoot; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
  }
  heading.scrollIntoView({ block: 'center', inline: 'nearest' });
  if (moveFocus) heading.focus({ preventScroll: true });
}

export function jumpToReadonlyHeading(root: HTMLElement, target: string): boolean {
  const heading = Array.from(root.querySelectorAll<HTMLElement>(`[data-document-outline-target="${CSS.escape(target)}"]`))
    .find(element => element.closest('[data-document-outline-root]') === root);
  if (!heading) return false;
  jumpToDocumentHeading(heading, root, true);
  return true;
}

export function OutlineEntries<Target extends string | number>({ entries, onNavigate, onMouseDown, onCreateSectionLink, onCopySectionLink, label = '문서 제목', layout = 'list', limit = entries.length }: {
  entries: DocumentOutlineEntry<Target>[];
  onNavigate: (target: Target) => void;
  onMouseDown?: (event: MouseEvent<HTMLElement>) => void;
  onCreateSectionLink?: (target: Target) => void;
  onCopySectionLink?: (sectionId: string) => void;
  label?: string;
  layout?: DocumentTocLayout;
  limit?: number;
}) {
  const titleCounts = new Map<string, number>();
  for (const { title } of entries) titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
  const occurrences = new Map<string, number>();
  return <nav className="document-outline-navigation" aria-label={label} data-outline-layout={layout}>
    <ol className="document-outline-entries" role="list">
      {entries.slice(0, limit).map(({ target, level, title, sectionId, sectionLinkPending }) => {
        const occurrence = (occurrences.get(title) ?? 0) + 1;
        const total = titleCounts.get(title) ?? 1;
        occurrences.set(title, occurrence);
        const label = total > 1 ? `${title} (${occurrence}/${total})` : title;
        return <li key={target} data-heading-level={level}>
          <button className="document-outline-entry" type="button" onMouseDown={onMouseDown} onClick={() => onNavigate(target)}>
            {label}
          </button>
          {sectionId && onCopySectionLink && <button className="document-outline-link" type="button"
            aria-label={`절 링크 복사 ${label}`} title={sectionLinkPending ? '절 링크 저장 후 복사할 수 있습니다.' : '절 링크 복사'}
            disabled={sectionLinkPending} onMouseDown={onMouseDown} onClick={() => onCopySectionLink(sectionId)}>
            <Copy size={15} aria-hidden="true" />
          </button>}
          {!sectionId && onCreateSectionLink && <button className="document-outline-link" type="button"
            aria-label={`절 링크 만들기 ${label}`} title="절 링크 만들기"
            onMouseDown={onMouseDown} onClick={() => onCreateSectionLink(target)}>
            <Link2 size={15} aria-hidden="true" />
          </button>}
        </li>;
      })}
    </ol>
  </nav>;
}

export function DocumentOutline<Target extends string | number>({ entries, onNavigate, preservePointerSelection = false, onCreateSectionLink, sectionLinkHref }: {
  entries: DocumentOutlineEntry<Target>[];
  onNavigate: (target: Target) => void;
  preservePointerSelection?: boolean;
  onCreateSectionLink?: (target: Target) => void;
  sectionLinkHref?: (sectionId: string) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [feedback, setFeedback] = useState<{ copied: true } | { copied: false; href: string } | null>(null);
  const fallback = useRef<HTMLInputElement>(null);
  const copyRequest = useRef(0);
  useEffect(() => {
    if (!expanded || feedback?.copied !== false) return;
    fallback.current?.focus();
    fallback.current?.select();
  }, [expanded, feedback]);
  if (!entries.length) return null;
  const onMouseDown = preservePointerSelection ? (event: MouseEvent<HTMLElement>) => event.preventDefault() : undefined;
  async function copySectionLink(getHref: (sectionId: string) => string, sectionId: string) {
    const href = new URL(getHref(sectionId), window.location.href).href;
    const request = ++copyRequest.current;
    try {
      await navigator.clipboard.writeText(href);
      if (copyRequest.current === request) setFeedback({ copied: true });
    } catch {
      if (copyRequest.current === request) setFeedback({ copied: false, href });
    }
  }
  return <details className="document-outline" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary className="document-outline-summary" onMouseDown={onMouseDown}>문서 목차</summary>
    {expanded && <>
      <OutlineEntries entries={entries} onNavigate={onNavigate} onMouseDown={onMouseDown} onCreateSectionLink={onCreateSectionLink}
        onCopySectionLink={sectionLinkHref && (sectionId => { void copySectionLink(sectionLinkHref, sectionId); })} />
      {entries.some(entry => entry.sectionLinkPending) && <p className="document-outline-link-feedback" role="status">
        문서를 저장하거나 동기화하면 절 링크를 복사할 수 있습니다.
      </p>}
      {feedback?.copied === true && <p className="document-outline-link-feedback" role="status">절 링크를 복사했습니다.</p>}
      {feedback?.copied === false && <div className="document-outline-link-feedback">
        <label>절 링크 주소<input ref={fallback} className="field" readOnly value={feedback.href} onFocus={event => event.currentTarget.select()} /></label>
      </div>}
    </>}
  </details>;
}
