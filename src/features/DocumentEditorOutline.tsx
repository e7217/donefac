'use client';

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { Editor } from '@tiptap/react';
import { DocumentOutline, jumpToDocumentHeading, outlineHeadingTitle, type DocumentOutlineEntry } from './DocumentOutline';

const emptyDocument = () => null;

export function DocumentEditorOutline({ editor }: { editor: Editor | null }) {
  const subscribe = useCallback((changed: () => void) => {
    editor?.on('create', changed);
    editor?.on('transaction', changed);
    return () => {
      editor?.off('create', changed);
      editor?.off('transaction', changed);
    };
  }, [editor]);
  const readDocument = useCallback(() => editor && !editor.isDestroyed ? editor.state.doc : null, [editor]);
  const content = useSyncExternalStore(subscribe, readDocument, emptyDocument);
  const entries = useMemo(() => {
    const headings: DocumentOutlineEntry<number>[] = [];
    content?.descendants((node, position) => {
      if (node.type.name !== 'heading') return;
      const title = outlineHeadingTitle(node.textBetween(0, node.content.size, '', child => child.type.name === 'statusBadge' ? String(child.attrs.label) : ' '));
      if (title) headings.push({ target: position, level: node.attrs.level, title });
      return false;
    });
    return headings;
  }, [content]);

  function navigate(target: number) {
    if (!editor || editor.isDestroyed || editor.state.doc !== content) return;
    const heading = editor.view.nodeDOM(target);
    if (heading instanceof HTMLElement) jumpToDocumentHeading(heading, editor.view.dom);
  }

  return <DocumentOutline entries={entries} onNavigate={navigate} preservePointerSelection />;
}
