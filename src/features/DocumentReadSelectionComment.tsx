'use client';

import { useEffect, useMemo, useState, type RefObject } from 'react';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { MessageSquarePlus } from 'lucide-react';
import { DOCUMENT_SELECTION_TEXT_LIMIT, documentSelectionText } from '../../shared/document-selection';
import { createEditorSchema } from '../../shared/editor-schema';
import type { DocumentSourceSelection, RichContent } from '../../shared/types';

const sourceMarker = '[data-document-find-text]';
let schema: ReturnType<typeof createEditorSchema> | undefined;

function textBoundary(node: Node, offset: number, start: boolean) {
  if (node instanceof Text) return { node, offset };
  const child = node.childNodes[start ? offset : offset - 1];
  if (!child) return null;
  const walker = child.ownerDocument?.createTreeWalker(child, NodeFilter.SHOW_TEXT);
  const text = child instanceof Text ? child : start ? walker?.firstChild() : walker?.lastChild();
  return text instanceof Text ? { node: text, offset: start ? 0 : text.length } : null;
}

function storedPosition(document: ProseMirrorNode, content: RichContent, root: HTMLElement, boundary: ReturnType<typeof textBoundary>) {
  if (!boundary) return null;
  const { node, offset } = boundary;
  const marker = node.parentElement?.closest<HTMLElement>(sourceMarker);
  const path = marker?.dataset.documentFindText;
  if (!path || !/^readonly(?::\d+)+$/u.test(path) || marker?.closest('[data-document-outline-root]') !== root) return null;
  let part = document;
  let saved = content;
  let position = -1;
  for (const step of path.split(':').slice(1)) {
    const index = Number(step);
    const children = saved.content;
    if (saved.type !== part.type.name || children?.length !== part.childCount || index >= part.childCount) return null;
    position++;
    for (let previous = 0; previous < index; previous++) position += part.child(previous).nodeSize;
    part = part.child(index);
    saved = children[index];
  }
  return part.isText && saved.type === 'text' && saved.text === part.text && part.text === node.data && offset <= node.length
    ? position + offset : null;
}

function spansSavedBody(root: HTMLElement, first: Text, last: Text) {
  if (first === last) return true;
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  walker.currentNode = first;
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    if (current === last) return true;
    if (!current.textContent?.trim()) continue;
    const marker = current.parentElement?.closest(`${sourceMarker}, [data-document-find-separator]`);
    if (marker?.closest('[data-document-outline-root]') !== root) return false;
  }
  return false;
}

function readerSelection(content: RichContent) {
  let source: ProseMirrorNode | undefined;
  return (root: HTMLDivElement | null): DocumentSourceSelection | null => {
    const selection = root?.ownerDocument.getSelection();
    if (!root || !selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
    const visible = selection.toString();
    if (!visible.trim() || visible.length > DOCUMENT_SELECTION_TEXT_LIMIT) return null;
    const first = textBoundary(range.startContainer, range.startOffset, true);
    const last = textBoundary(range.endContainer, range.endOffset, false);
    if (!first || !last) return null;
    try {
      source ??= (schema ??= createEditorSchema()).nodeFromJSON(content);
      const from = storedPosition(source, content, root, first);
      const to = storedPosition(source, content, root, last);
      if (from === null || to === null || !spansSavedBody(root, first.node, last.node)) return null;
      const text = documentSelectionText(source, from, to);
      const normalize = (value: string) => value.replace(/\s+/gu, ' ').trim();
      // A read selection can span included or generated content that does not belong to the saved document.
      return text && normalize(text) === normalize(visible) ? { from, to, text } : null;
    } catch { return null; }
  };
}

export function DocumentReadSelectionComment({ content, contentRef, disabled, onComment }: {
  content: RichContent;
  contentRef: RefObject<HTMLDivElement | null>;
  disabled: boolean;
  onComment: (range: DocumentSourceSelection, opener: HTMLButtonElement) => void;
}) {
  const reader = useMemo(() => ({ read: readerSelection(content) }), [content]);
  const [available, setAvailable] = useState<typeof reader | null>(null);
  useEffect(() => {
    const owner = contentRef.current?.ownerDocument;
    if (!owner) return;
    const update = () => setAvailable(reader.read(contentRef.current) ? reader : null);
    owner.addEventListener('selectionchange', update);
    return () => owner.removeEventListener('selectionchange', update);
  }, [contentRef, reader]);
  const enabled = !disabled && available === reader;
  const label = '선택한 본문에 댓글 남기기';
  return <button type="button" className="btn btn-ghost docs-icon-button docs-read-selection-comment" aria-disabled={!enabled}
    aria-label={label} title={enabled ? label : '저장본 본문에서 문장을 선택해 주세요.'}
    onMouseDown={event => { if (enabled) event.preventDefault(); }} onClick={event => {
      if (!enabled) return;
      const selection = reader.read(contentRef.current);
      if (selection) onComment(selection, event.currentTarget);
    }}><MessageSquarePlus size={15} aria-hidden="true" /></button>;
}
