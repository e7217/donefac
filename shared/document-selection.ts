import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

export const DOCUMENT_SELECTION_TEXT_LIMIT = 2_000;

/** ProseMirror positions describe the document's own text, without rendered include contents. */
export function documentSelectionText(document: ProseMirrorNode, from: number, to: number): string | null {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || from >= to || to > document.content.size) return null;
  const text = document.textBetween(from, to, '\n', node => node.type.name === 'hardBreak' ? '\n' : '');
  return text.length <= DOCUMENT_SELECTION_TEXT_LIMIT && text.trim() && text.isWellFormed() ? text : null;
}
