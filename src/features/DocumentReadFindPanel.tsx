'use client';

import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import type { RichContent } from '../../shared/types';
import { revealDocumentTarget } from './DocumentOutline';
import { DOCUMENT_FIND_MATCH_LIMIT, DOCUMENT_FIND_QUERY_LIMIT, documentFindPattern } from './document-find';
import './document-find.css';

type Match = { range: Range; block: HTMLElement };
type Matches = { matches: Match[]; truncated: boolean };
type SearchResult = { query: string; caseSensitive: boolean; content: RichContent; result: Matches };
type Part = { node: Text; from: number; to: number };
const allHighlights = 'donefac-document-reader-find';
const activeHighlight = 'donefac-document-reader-find-current';
const emptyResult: Matches = { matches: [], truncated: false };

function findInSavedBody(root: HTMLElement, pattern: RegExp): Matches {
  const matches: Match[] = [];
  const owner = root.ownerDocument;
  const blocks = root.querySelectorAll<HTMLElement>('[data-document-find-block]');
  for (const block of blocks) {
    const walker = owner.createTreeWalker(block, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: node => node instanceof Element ?
        (node.matches('br, [data-document-find-separator]') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) : NodeFilter.FILTER_ACCEPT,
    });
    let run = '';
    let parts: Part[] = [];

    function scanRun(): boolean {
      pattern.lastIndex = 0;
      let first = 0;
      for (let found = pattern.exec(run); found; found = pattern.exec(run)) {
        if (matches.length >= DOCUMENT_FIND_MATCH_LIMIT) return false;
        const from = found.index;
        const to = from + found[0].length;
        while (parts[first].to <= from) first++;
        let last = first;
        while (parts[last].to < to) last++;
        const range = owner.createRange();
        range.setStart(parts[first].node, from - parts[first].from);
        range.setEnd(parts[last].node, to - parts[last].from);
        matches.push({ range, block });
      }
      run = '';
      parts = [];
      return true;
    }

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node instanceof Text && node.parentElement?.closest('[data-document-find-text]')) {
        if (!node.length) continue;
        const from = run.length;
        run += node.data;
        parts.push({ node, from, to: run.length });
      } else if (!scanRun()) return { matches, truncated: true };
    }
    if (!scanRun()) return { matches, truncated: true };
  }
  return { matches, truncated: false };
}

function scrollToMatch(match: Match, root: HTMLElement) {
  revealDocumentTarget(match.block, root);
  const scroll = root.closest<HTMLElement>('.docs-paper-scroll');
  if (!scroll || scroll.scrollHeight <= scroll.clientHeight) return;
  const matchRect = match.range.getClientRects()[0];
  if (!matchRect) return;
  const viewport = scroll.getBoundingClientRect();
  if (matchRect.top < viewport.top || matchRect.bottom > viewport.bottom) {
    scroll.scrollBy({ top: matchRect.top - viewport.top - viewport.height / 2 });
  }
}

export function DocumentReadFindPanel({ inputRef, contentRef, content, onClose }: {
  inputRef: RefObject<HTMLInputElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  content: RichContent;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [index, setIndex] = useState(0);
  const [reveal, setReveal] = useState(0);
  const lastReveal = useRef(0);
  const [saved, setSaved] = useState<SearchResult | null>(null);
  const result = saved?.content === content && saved.query === query && saved.caseSensitive === caseSensitive ? saved.result : emptyResult;
  const count = result.matches.length;
  const active = Math.min(index, count - 1);

  useLayoutEffect(() => { inputRef.current?.focus({ preventScroll: true }); }, [inputRef]);
  useLayoutEffect(() => {
    const root = contentRef.current;
    const pattern = documentFindPattern(query, caseSensitive);
    setSaved(root && pattern ? { content, query, caseSensitive, result: findInSavedBody(root, pattern) } : null);
  }, [contentRef, content, query, caseSensitive]);
  useLayoutEffect(() => {
    const root = contentRef.current;
    const match = result.matches[active];
    if (!root || !match) return;
    const registry = typeof Highlight !== 'undefined' ? CSS.highlights : undefined;
    if (registry) {
      registry.set(allHighlights, new Highlight(...result.matches.map(item => item.range)));
      const highlight = new Highlight(match.range);
      highlight.priority = 1;
      registry.set(activeHighlight, highlight);
    }
    match.block.setAttribute('data-document-reader-find-current', registry ? 'text' : 'block');
    if (lastReveal.current !== reveal) {
      lastReveal.current = reveal;
      scrollToMatch(match, root);
    }
    return () => {
      match.block.removeAttribute('data-document-reader-find-current');
      registry?.delete(allHighlights);
      registry?.delete(activeHighlight);
    };
  }, [active, contentRef, result, reveal]);

  function changeSearch() {
    setIndex(0);
    setReveal(current => current + 1);
  }

  function navigate(step: number) {
    if (!count) return;
    setIndex((active + step + count) % count);
    setReveal(current => current + 1);
  }

  return <section role="search" aria-label="저장본 본문 찾기" className="docs-find-panel docs-reader-find-panel" onKeyDown={event => {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  }}>
    <div className="docs-find-controls">
      <input ref={inputRef} type="text" className="field" aria-label="찾을 텍스트" placeholder="찾을 텍스트"
        autoComplete="off" maxLength={DOCUMENT_FIND_QUERY_LIMIT} value={query} onChange={event => {
          setQuery(event.currentTarget.value);
          changeSearch();
        }} onKeyDown={event => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
          event.preventDefault();
          navigate(event.shiftKey ? -1 : 1);
        }} />
      <button type="button" className="btn" aria-label="이전 결과" title="이전 결과" disabled={!count} onClick={() => navigate(-1)}>
        <ChevronUp size={16} aria-hidden="true" />
      </button>
      <button type="button" className="btn" aria-label="다음 결과" title="다음 결과" disabled={!count} onClick={() => navigate(1)}>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      <button type="button" className="btn btn-ghost" aria-label="찾기 닫기" title="찾기 닫기" onClick={onClose}>
        <X size={16} aria-hidden="true" />
      </button>
    </div>
    <div className="docs-find-options">
      <span role="status" className="docs-find-count">{query && (count
        ? `${count.toLocaleString('ko-KR')}개${result.truncated ? ' 이상' : ''} 중 ${(active + 1).toLocaleString('ko-KR')}번째`
        : '검색 결과 없음')}</span>
      <label><input type="checkbox" checked={caseSensitive} onChange={event => {
        setCaseSensitive(event.currentTarget.checked);
        changeSearch();
      }} />대소문자 구분</label>
    </div>
  </section>;
}
