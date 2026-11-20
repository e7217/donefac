import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

export const DOCUMENT_SELECTION_TEXT_LIMIT = 2_000;

/** ProseMirror positions describe the document's own text, without rendered include contents. */
export function documentSelectionText(document: ProseMirrorNode, from: number, to: number): string | null {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || from >= to || to > document.content.size) return null;
  const text = document.textBetween(from, to, '\n', node => {
    if (node.type.name === 'hardBreak') return '\n';
    if (node.type.name === 'statusBadge' && typeof node.attrs.label === 'string') return node.attrs.label;
    return '';
  });
  return text.length <= DOCUMENT_SELECTION_TEXT_LIMIT && text.trim() && text.isWellFormed() ? text : null;
}
