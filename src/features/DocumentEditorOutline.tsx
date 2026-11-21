'use client';

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { Editor } from '@tiptap/react';
import type { Node as EditorNode } from '@tiptap/pm/model';
import { documentSectionHash, isDocumentSectionId, outlineHeadingTitle } from '../../shared/document-sections';
import type { RichContent } from '../../shared/types';
import { newRequestId } from '../lib/request-id';
import { DocumentOutline, revealDocumentTarget, type DocumentOutlineEntry } from './DocumentOutline';

const emptyDocument = () => null;
const headingCache = new WeakMap<EditorNode, DocumentOutlineEntry<number>[]>();

export function useOutlineDocument(editor: Editor | null) {
  const subscribe = useCallback((changed: () => void) => {
    editor?.on('create', changed);
    editor?.on('transaction', changed);
    return () => {
      editor?.off('create', changed);
      editor?.off('transaction', changed);
    };
  }, [editor]);
  const readDocument = useCallback(() => editor && !editor.isDestroyed ? editor.state.doc : null, [editor]);
  return useSyncExternalStore(subscribe, readDocument, emptyDocument);
}

export function editorHeadings(content: EditorNode): DocumentOutlineEntry<number>[] {
  const cached = headingCache.get(content);
  if (cached) return cached;
  const headings: DocumentOutlineEntry<number>[] = [];
  content.descendants((node, position) => {
    if (node.type.name !== 'heading') return;
    const id = isDocumentSectionId(node.attrs.sectionId) ? node.attrs.sectionId : undefined;
    const title = outlineHeadingTitle(node.textBetween(0, node.content.size, '', child => child.type.name === 'statusBadge' ? String(child.attrs.label) : ' '));
    if (title || id) headings.push({ target: position, level: node.attrs.level, title, sectionId: id });
    return false;
  });
  headingCache.set(content, headings);
  return headings;
}

function savedSectionIds(content: RichContent | null | undefined) {
  const ids = new Set<string>();
  const pending = content ? [content] : [];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.type === 'heading' && isDocumentSectionId(node.attrs?.sectionId)) ids.add(node.attrs.sectionId);
    for (const child of node.content || []) pending.push(child);
  }
  return ids;
}

export function DocumentEditorOutline({ editor, documentId, projectId, sectionId, savedContent, ready = true, canAssign = true }: {
  editor: Editor | null;
  documentId?: string;
  projectId?: string;
  sectionId?: string | null;
  savedContent?: RichContent | null;
  ready?: boolean;
  canAssign?: boolean;
}) {
  const lastJump = useRef<{ editor: Editor; documentId?: string; sectionId: string } | null>(null);
  const content = useOutlineDocument(editor);
  const savedIds = useMemo(() => savedSectionIds(savedContent), [savedContent]);
  const { entries, routeTarget } = useMemo(() => {
    const headings = content ? editorHeadings(content) : [];
    return {
      entries: headings.filter(heading => heading.title).map(heading => ({
        ...heading, sectionLinkPending: Boolean(heading.sectionId && !savedIds.has(heading.sectionId)),
      })),
      routeTarget: sectionId ? headings.find(heading => heading.sectionId === sectionId)?.target : undefined,
    };
  }, [content, sectionId, savedIds]);

  useEffect(() => {
    if (lastJump.current && (lastJump.current.editor !== editor || lastJump.current.documentId !== documentId || lastJump.current.sectionId !== sectionId)) {
      lastJump.current = null;
    }
    if (!ready || !editor || !sectionId || routeTarget === undefined || lastJump.current) return;
    const frame = requestAnimationFrame(() => {
      if (editor.isDestroyed || editor.state.doc !== content) return;
      const heading = editor.view.nodeDOM(routeTarget);
      if (heading instanceof HTMLElement) {
        revealDocumentTarget(heading, editor.view.dom, true);
        lastJump.current = { editor, documentId, sectionId };
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [ready, editor, content, documentId, sectionId, routeTarget]);

  function navigate(target: number) {
    if (!editor || editor.isDestroyed || editor.state.doc !== content) return;
    const heading = editor.view.nodeDOM(target);
    if (heading instanceof HTMLElement) revealDocumentTarget(heading, editor.view.dom);
  }

  function assignSectionLink(target: number) {
    if (!ready || !canAssign || !editor || editor.isDestroyed || !editor.isEditable || editor.state.doc !== content) return;
    const { state, view } = editor;
    const heading = state.doc.nodeAt(target);
    if (heading?.type.name !== 'heading' || isDocumentSectionId(heading.attrs.sectionId)) return;
    view.dispatch(state.tr.setNodeMarkup(target, undefined, { ...heading.attrs, sectionId: newRequestId() }));
  }

  return <>
    {ready && content && sectionId && routeTarget === undefined && <p className="document-section-not-found" role="status">
      이 문서에서 연결된 절을 찾을 수 없습니다.
    </p>}
    <DocumentOutline entries={entries} onNavigate={navigate} preservePointerSelection
      onCreateSectionLink={documentId && ready && canAssign ? assignSectionLink : undefined}
      sectionLinkHref={documentId ? id => documentSectionHash(documentId, id, projectId) : undefined} />
  </>;
}
