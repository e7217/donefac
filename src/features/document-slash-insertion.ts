'use client';

import { useCallback, useLayoutEffect, useRef } from 'react';
import type { Editor, EditorEvents, JSONContent } from '@tiptap/core';
import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Selection, type Transaction } from '@tiptap/pm/state';
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ySyncPluginKey } from '@tiptap/y-tiptap';
import { compareRelativePositions, createAbsolutePositionFromRelativePosition, type Doc, type RelativePosition, XmlElement, XmlText } from 'yjs';

export type DocumentSlashRange = { from: number; to: number; text: string };
export type DocumentSlashAnchor = {
  editor: Editor;
  document: ProseMirrorNode;
  range: DocumentSlashRange;
  atTokenEnd: boolean;
  collaboration?: {
    document: Doc;
    afterSlash: RelativePosition;
    end: RelativePosition;
    block: XmlElement;
    parent: XmlElement['parent'];
    previous: XmlElement['prevSibling'];
    next: XmlElement['nextSibling'];
  };
};

function slashPositions(doc: ProseMirrorNode, { from, to, text }: DocumentSlashRange) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > doc.content.size ||
      to - from !== text.length || !/^\/[^\s/]*$/u.test(text)) return null;
  const start = doc.resolve(from), end = doc.resolve(to);
  if (!start.sameParent(end) || start.parentOffset !== 0 || !start.parent.isTextblock || start.parent.type.spec.code ||
      start.parent.textBetween(0, end.parentOffset, '', '\ufffc') !== text) return null;
  return { start, end };
}

function endsToken({ parent, parentOffset }: NonNullable<ReturnType<typeof slashPositions>>['end']) {
  const next = parent.textBetween(parentOffset, Math.min(parentOffset + 1, parent.content.size), '', '\ufffc');
  return !next || /[\s/\ufffc]/u.test(next);
}

function validRange(doc: ProseMirrorNode, range: DocumentSlashRange, anchor: DocumentSlashAnchor): boolean {
  const positions = slashPositions(doc, range);
  return Boolean(positions && (!anchor.atTokenEnd || endsToken(positions.end)));
}

export function captureDocumentSlashAnchor(editor: Editor, range: DocumentSlashRange): DocumentSlashAnchor | null {
  if (editor.isDestroyed || !editor.isEditable) return null;
  const { state } = editor;
  const positions = slashPositions(state.doc, range);
  if (!positions) return null;
  const anchor: DocumentSlashAnchor = { editor, document: state.doc, range, atTokenEnd: endsToken(positions.end) };
  const sync = ySyncPluginKey.getState(state);
  if (!sync) return anchor;
  if (sync.snapshot || sync.prevSnapshot) return null;
  try {
    const relativeAt = (position: number) => absolutePositionToRelativePosition(position, sync.type, sync.binding.mapping);
    // The left endpoint follows the original slash character as content before the block moves.
    const afterSlash = relativeAt(range.from + 1);
    const end = relativeAt(range.to);
    if (!afterSlash.item || !end.item) return null;
    const source = createAbsolutePositionFromRelativePosition(afterSlash, sync.doc)?.type;
    const block = source instanceof XmlText ? source.parent : null;
    if (!(block instanceof XmlElement)) return null;
    return { ...anchor, collaboration: {
      document: sync.doc, afterSlash, end, block, parent: block.parent, previous: block.prevSibling, next: block.nextSibling,
    } };
  } catch {
    return null;
  }
}

function resolveCollaborativeRange(editor: Editor, anchor: DocumentSlashAnchor): DocumentSlashRange | null {
  const sync = ySyncPluginKey.getState(editor.state);
  const saved = anchor.collaboration;
  if (!saved || !sync || sync.doc !== saved.document || sync.snapshot || sync.prevSnapshot) return null;
  // The collaborative projection can reuse an identical paragraph as a preserved suffix.
  if (saved.block.parent !== saved.parent || saved.block.prevSibling !== saved.previous || saved.block.nextSibling !== saved.next) return null;
  try {
    const resolve = (position: RelativePosition) => {
      const absolute = relativePositionToAbsolutePosition(sync.doc, sync.type, position, sync.binding.mapping);
      if (absolute === null) return null;
      const current = absolutePositionToRelativePosition(absolute, sync.type, sync.binding.mapping);
      return compareRelativePositions(position, current) ? absolute : null;
    };
    const afterSlash = resolve(saved.afterSlash), to = resolve(saved.end);
    if (afterSlash === null || to === null) return null;
    const range = { from: afterSlash - 1, to, text: anchor.range.text };
    return validRange(editor.state.doc, range, anchor) ? range : null;
  } catch {
    return null;
  }
}

function mapManualRange(range: DocumentSlashRange, transaction: Transaction): DocumentSlashRange | null {
  const from = transaction.mapping.mapResult(range.from, 1);
  const to = transaction.mapping.mapResult(range.to, -1);
  return from.deleted || to.deleted ? null : { from: from.pos, to: to.pos, text: range.text };
}

export function useDocumentSlashRange(editor: Editor, anchor?: DocumentSlashAnchor): () => DocumentSlashRange | null {
  const tracking = useRef<{ anchor: DocumentSlashAnchor; document: ProseMirrorNode; range: DocumentSlashRange | null } | null>(null);
  useLayoutEffect(() => {
    if (!anchor || anchor.editor !== editor || editor.isDestroyed) return;
    const tracked = {
      anchor,
      document: editor.state.doc,
      range: anchor.collaboration ? resolveCollaborativeRange(editor, anchor) : editor.state.doc === anchor.document ? anchor.range : null,
    };
    tracking.current = tracked;
    const update = ({ transaction, appendedTransactions }: EditorEvents['transaction']) => {
      if (!tracked.range || tracked.document === editor.state.doc) return;
      tracked.document = editor.state.doc;
      if (anchor.collaboration) {
        tracked.range = resolveCollaborativeRange(editor, anchor);
        return;
      }
      let range: DocumentSlashRange | null = tracked.range;
      for (const step of [transaction, ...appendedTransactions]) {
        if (!range) break;
        range = mapManualRange(range, step);
        if (range && !validRange(step.doc, range, anchor)) range = null;
      }
      tracked.range = range;
    };
    editor.on('transaction', update);
    return () => {
      editor.off('transaction', update);
      if (tracking.current === tracked) tracking.current = null;
    };
  }, [anchor, editor]);
  return useCallback(() => {
    const tracked = tracking.current;
    if (editor.isDestroyed || !editor.isEditable || !tracked || tracked.anchor !== anchor ||
        !tracked.range || tracked.document !== editor.state.doc) return null;
    return validRange(editor.state.doc, tracked.range, tracked.anchor) ? tracked.range : null;
  }, [anchor, editor]);
}

export function restoreDocumentSlashFocus(editor: Editor) {
  if (editor.isDestroyed || !editor.isEditable) return;
  const { dom } = editor.view;
  const document = dom.ownerDocument;
  document.defaultView?.requestAnimationFrame(() => {
    if (editor.isDestroyed || !editor.isEditable || editor.view.dom !== dom || !dom.isConnected) return;
    const active = document.activeElement;
    if (!active || active === document.body) editor.view.focus();
  });
}

export function insertDocumentSlashBlocks(editor: Editor, range: DocumentSlashRange, content: JSONContent[]): boolean {
  if (editor.isDestroyed || !editor.isEditable || !content.length) return false;
  const { state } = editor;
  const positions = slashPositions(state.doc, range);
  if (!positions) return false;
  const { start, end } = positions;
  try {
    const blocks = content.map(value => state.schema.nodeFromJSON(value));
    if (blocks.some(node => !node.isBlock)) return false;
    blocks.forEach(node => node.check());
    const residual = start.parent.copy(start.parent.content.cut(end.parentOffset));
    const grandparent = start.node(start.depth - 1);
    const index = start.index(start.depth - 1);
    const at = start.before(), afterTextblock = start.after();
    let replacement = Fragment.fromArray(residual.content.size ? [...blocks, residual] : blocks);
    let insertAt = at;
    if (!grandparent.canReplace(index, index + 1, replacement)) {
      // List items can require an initial paragraph. Keep it ahead of the chosen blocks.
      replacement = Fragment.fromArray([residual, ...blocks]);
      if (!grandparent.canReplace(index, index + 1, replacement)) return false;
      insertAt += residual.nodeSize;
    }
    const tr = state.tr.replaceWith(at, afterTextblock, replacement);
    let insertionEnd = insertAt;
    for (const block of blocks) {
      if (!tr.doc.nodeAt(insertionEnd)?.eq(block)) return false;
      insertionEnd += block.nodeSize;
    }
    tr.setSelection(Selection.near(tr.doc.resolve(insertionEnd), -1));
    editor.view.dispatch(tr.scrollIntoView());
    if (editor.state.doc === state.doc) return false;
    restoreDocumentSlashFocus(editor);
    return true;
  } catch {
    return false;
  }
}
