'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Editor, EditorEvents } from '@tiptap/core';
import { Fragment } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { normalizeWorkspaceSearchKey } from '../../shared/workspace-search';
import type { DocPage, Project } from '../../shared/types';
import './document-page-suggestions.css';

const maxQueryLength = 120;
const resultLimit = 8;

function readToken(editor: Editor) {
  const { doc, selection } = editor.state;
  if (!(selection instanceof TextSelection) || !selection.empty || editor.view.composing) return null;
  const { $from } = selection;
  const { parent, parentOffset } = $from;
  if (!parent.isTextblock || parent.type.spec.code || !parent.type.allowsMarkType(editor.schema.marks.link)) return null;
  const start = Math.max(0, parentOffset - maxQueryLength - 2);
  const before = parent.textBetween(start, parentOffset, '\ufffc', '\ufffc');
  const match = /(?:^|[\s([\u300c])(@([^@\ufffc\r\n]*))$/u.exec(before);
  if (!match || match[2].length > maxQueryLength || (start && match.index === 0 && match[0].startsWith('@'))) return null;
  const offset = parentOffset - match[1].length;
  let isPlain = true;
  parent.nodesBetween(offset, parentOffset, node => {
    if (!node.isText || node.marks.some(mark => mark.type.name === 'code' || mark.type.name === 'link')) isPlain = false;
  });
  if (!isPlain) return null;
  return { doc, from: $from.start() + offset, to: $from.pos, text: match[1], query: match[2] };
}

type Token = NonNullable<ReturnType<typeof readToken>>;
type Suggestion = { token: Token; top: number };

function pagePath(page: DocPage, pages: ReadonlyMap<string, DocPage>, projectNames: ReadonlyMap<string, string>) {
  const parents: string[] = [];
  const seen = new Set([page.id]);
  let parentId = page.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = pages.get(parentId);
    if (!parent) break;
    parents.push(parent.title);
    parentId = parent.parentId;
  }
  return [page.projectId ? projectNames.get(page.projectId) ?? '프로젝트' : '팀 공통', ...parents.reverse()].join(' / ');
}

export function DocumentPageSuggestions({ editor, wrap, documentId, documents, projects }: {
  editor: Editor;
  wrap: RefObject<HTMLDivElement | null>;
  documentId: string;
  documents: readonly DocPage[];
  projects: readonly Project[];
}) {
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [highlight, setHighlight] = useState(0);
  const current = useRef<Suggestion | null>(null);
  const dismissed = useRef<number | null>(null);
  const options = useRef<HTMLDivElement>(null);
  const pagesById = useMemo(() => new Map(documents.map(page => [page.id, page])), [documents]);
  const projectNames = useMemo(() => new Map(projects.map(project => [project.id, project.name])), [projects]);
  const candidates = useMemo(() => documents.filter(page => page.id !== documentId).map(page => {
    const title = page.title || '제목 없는 문서';
    const path = pagePath(page, pagesById, projectNames);
    return { page, title, path, titleKey: normalizeWorkspaceSearchKey(title), pathKey: normalizeWorkspaceSearchKey(path) };
  }), [documentId, documents, pagesById, projectNames]);
  const query = suggestion?.token.query;
  const matches = useMemo(() => {
    if (query === undefined) return [];
    const key = normalizeWorkspaceSearchKey(query);
    const terms = key.split(' ');
    return candidates.flatMap(result => {
      const { titleKey, pathKey } = result;
      if (!terms.every(term => titleKey.includes(term) || pathKey.includes(term))) return [];
      const rank = titleKey === key ? 0 : titleKey.startsWith(key) ? 1 : terms.every(term => titleKey.includes(term)) ? 2 : 3;
      return [{ ...result, rank }];
    }).sort((left, right) => left.rank - right.rank || right.page.updatedAt.localeCompare(left.page.updatedAt) ||
      left.title.localeCompare(right.title, 'ko') || left.page.id.localeCompare(right.page.id)).slice(0, resultLimit);
  }, [candidates, query]);
  const selected = Math.min(highlight, matches.length - 1);

  const clear = useCallback(() => {
    current.current = null;
    setSuggestion(null);
  }, []);

  const choose = useCallback(({ page, title }: (typeof candidates)[number], expected: Suggestion) => {
    if (editor.isDestroyed || !editor.isEditable || current.current !== expected || pagesById.get(page.id) !== page) return;
    const token = readToken(editor);
    const previous = expected.token;
    if (!token || token.doc !== previous.doc || token.from !== previous.from || token.to !== previous.to || token.text !== previous.text) {
      clear();
      return;
    }
    const { state, view } = editor;
    const marks = state.doc.resolve(token.from).marks().filter(mark => mark.type.name !== 'link' && mark.type.name !== 'code');
    const href = `#/${encodeURIComponent(page.projectId ?? 'all')}/documents/${encodeURIComponent(page.id)}`;
    const link = state.schema.marks.link.create({ href });
    const text = state.schema.text(title, link.addToSet(marks));
    const separator = state.schema.text(' ', marks);
    const tr = state.tr.replaceWith(token.from, token.to, Fragment.fromArray([text, separator]));
    tr.setSelection(TextSelection.create(tr.doc, token.from + text.nodeSize + separator.nodeSize));
    tr.setStoredMarks(marks);
    clear();
    view.focus();
    view.dispatch(tr.scrollIntoView());
  }, [clear, editor, pagesById]);

  useEffect(() => {
    const container = wrap.current;
    if (!container) return;
    const refresh = () => {
      if (!editor.isEditable || !editor.isFocused) { clear(); return; }
      const token = readToken(editor);
      if (!token || token.from === dismissed.current) { clear(); return; }
      const old = current.current;
      if (old?.token.doc === token.doc && old.token.to === token.to) return;
      const top = editor.view.coordsAtPos(token.to).bottom - container.getBoundingClientRect().top + 7;
      const next = { token, top };
      current.current = next;
      setSuggestion(next);
      if (!old || token.text !== old.token.text) setHighlight(0);
    };
    const update = ({ transaction, appendedTransactions }: EditorEvents['transaction']) => {
      const changes = [transaction, ...appendedTransactions];
      if (changes.some(change => change.getMeta(ySyncPluginKey)?.isChangeOrigin || change.getMeta('preventUpdate'))) {
        // A peer may have replaced the token even if its visible text still looks identical.
        dismissed.current = null;
        clear();
      } else if (changes.some(change => change.docChanged)) {
        for (const change of changes) {
          if (dismissed.current === null) break;
          const mapped = change.mapping.mapResult(dismissed.current, 1);
          dismissed.current = mapped.deleted ? null : mapped.pos;
        }
        refresh();
      } else if (changes.some(change => change.selectionSet)) clear();
    };
    let compositionFrame = 0;
    const compositionEnd = () => {
      window.cancelAnimationFrame(compositionFrame);
      compositionFrame = window.requestAnimationFrame(refresh);
    };
    const leave = (event: FocusEvent) => {
      if (!(event.relatedTarget instanceof Node) || !container.contains(event.relatedTarget)) clear();
    };
    editor.on('transaction', update);
    const dom = editor.view.dom;
    dom.addEventListener('compositionend', compositionEnd);
    container.addEventListener('focusout', leave);
    return () => {
      window.cancelAnimationFrame(compositionFrame);
      editor.off('transaction', update);
      dom.removeEventListener('compositionend', compositionEnd);
      container.removeEventListener('focusout', leave);
    };
  }, [clear, editor, wrap]);

  useLayoutEffect(() => {
    if (!suggestion) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || current.current !== suggestion) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        dismissed.current = suggestion.token.from;
        clear();
      } else if (!event.shiftKey && matches.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : matches.length - 1;
        setHighlight(index => (Math.min(index, matches.length - 1) + step) % matches.length);
      } else if (event.key === 'Enter' && !event.shiftKey && selected >= 0) {
        event.preventDefault();
        choose(matches[selected], suggestion);
      }
    };
    const dom = editor.view.dom;
    dom.addEventListener('keydown', onKey, true);
    return () => dom.removeEventListener('keydown', onKey, true);
  }, [choose, clear, editor, matches, selected, suggestion]);

  useLayoutEffect(() => {
    if (!suggestion || selected < 0) return;
    const option = options.current?.querySelector<HTMLButtonElement>('[aria-current="true"]');
    if (option) {
      const menu = options.current!;
      if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop;
      else if (option.offsetTop + option.offsetHeight > menu.scrollTop + menu.clientHeight) {
        menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight;
      }
    }
  }, [selected, suggestion]);

  if (!suggestion) return null;
  return <div ref={options} className="docs-popover docs-page-suggestions" role="group" aria-label="문서 링크 검색" style={{ top: suggestion.top }}>
    {matches.length === 0 ? <p className="docs-page-suggestions-empty" role="status">일치하는 문서가 없습니다.</p> : matches.map((result, index) => (
      <button key={result.page.id} type="button" aria-current={index === selected || undefined}
        onPointerDown={event => event.preventDefault()} onClick={() => choose(result, suggestion)}>
        <strong>{result.title}</strong><span>{result.path}</span>
      </button>
    ))}
  </div>;
}
