import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Tracks whether a horizontally scrollable row has hidden content at either
 * edge, so the row can fade that edge as a scroll affordance.
 */
/** `contentKey` changes whenever the row's items change, so the edges are measured again. */
export function useScrollEdges<T extends HTMLElement>(contentKey?: string) {
  const ref = useRef<T>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  const update = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const start = element.scrollLeft > 1;
    const end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
    setEdges(previous => previous.start === start && previous.end === end ? previous : { start, end });
  }, []);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    update();
    element.addEventListener('scroll', update, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(element);
    for (const child of Array.from(element.children)) observer?.observe(child);
    return () => { element.removeEventListener('scroll', update); observer?.disconnect(); };
  }, [update, contentKey]);
  return { ref, edges, update };
}

/** Mask classes for useScrollEdges: fade 24px at each edge that hides content. */
export function scrollEdgeMask(edges: { start: boolean; end: boolean }) {
  if (edges.start && edges.end) return '[mask-image:linear-gradient(to_right,transparent,black_24px,black_calc(100%-24px),transparent)]';
  if (edges.end) return '[mask-image:linear-gradient(to_right,black_calc(100%-24px),transparent)]';
  if (edges.start) return '[mask-image:linear-gradient(to_right,transparent,black_24px)]';
  return '';
}
