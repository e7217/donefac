import type { Editor } from '@tiptap/core';
import { Fragment } from '@tiptap/pm/model';
import { NodeSelection, Plugin, TextSelection, type Selection } from '@tiptap/pm/state';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { normalizeDocumentColumnLayoutOptions } from '../../shared/document-nodes';

type LayoutSlash = { from: number; to: number; text: string };

export function documentColumnLayoutEditingPlugin() {
  return new Plugin({
    appendTransaction(transactions, _previous, next) {
      if (!transactions.some(transaction => transaction.docChanged) ||
          transactions.some(transaction => transaction.getMeta(ySyncPluginKey)?.isChangeOrigin)) return null;
      const correction = next.tr;
      next.doc.descendants((node, position) => {
        if (node.type.name !== 'documentColumnLayout' || normalizeDocumentColumnLayoutOptions(node.attrs, node.childCount)) return;
        // A range edit can remove or merge whole columns. Their old widths no longer match.
        correction.setNodeAttribute(position, 'weights', Array<number>(node.childCount).fill(1));
        if (typeof node.attrs.border !== 'boolean') correction.setNodeAttribute(position, 'border', false);
      });
      return correction.docChanged ? correction : null;
    },
  });
}

function selectedLayout(selection: Selection) {
  if (selection instanceof NodeSelection && selection.node.type.name === 'documentColumnLayout') {
    return { node: selection.node, position: selection.from, depth: null };
  }
  const { $from } = selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === 'documentColumnLayout') return { node, position: $from.before(depth), depth };
  }
  return null;
}

export function insertDocumentColumnLayout(editor: Editor, count: 2 | 3, slash?: LayoutSlash) {
  if (!editor.isEditable) return false;
  return editor.chain().command(({ tr, state, dispatch }) => {
    const { paragraph, documentColumn, documentColumnLayout } = state.schema.nodes;
    const layout = documentColumnLayout.create({ weights: Array<number>(count).fill(1), border: false },
      Array.from({ length: count }, () => documentColumn.create(null, paragraph.create())));
    if (slash) {
      if (tr.selection.to !== slash.to || tr.doc.textBetween(slash.from, slash.to, '', '\ufffc') !== slash.text) return false;
      if (dispatch) tr.delete(slash.from, slash.to);
    }
    const { $to, empty } = tr.selection;
    const after = $to.depth ? $to.after(1) : $to.pos;
    const replaceEmpty = empty && $to.depth === 1 && $to.parent.type === paragraph && $to.parent.content.size === 0;
    const position = replaceEmpty ? $to.before(1) : after;
    const blocks = after === tr.doc.content.size ? [layout, paragraph.create()] : [layout];
    if (dispatch) {
      tr.replaceWith(position, after, blocks);
      tr.setSelection(TextSelection.create(tr.doc, position + 3)).scrollIntoView();
    }
    return true;
  }).focus().run();
}

export function exitDocumentColumnLayout(editor: Editor) {
  if (!editor.isEditable) return false;
  const layout = selectedLayout(editor.state.selection);
  if (!layout) return false;
  return editor.chain().command(({ tr, state, dispatch }) => {
    const end = layout.position + layout.node.nodeSize;
    const paragraph = state.schema.nodes.paragraph;
    const following = tr.doc.resolve(end);
    const hasParagraph = following.nodeAfter?.type === paragraph;
    if (!hasParagraph && !following.parent.canReplaceWith(following.index(), following.index(), paragraph)) return false;
    if (dispatch) {
      if (!hasParagraph) tr.insert(end, paragraph.create());
      tr.setSelection(TextSelection.create(tr.doc, end + 1)).scrollIntoView();
    }
    return true;
  }).focus().run();
}

export function unwrapDocumentColumnLayout(editor: Editor) {
  if (!editor.isEditable) return false;
  const { selection } = editor.state;
  const layout = selectedLayout(selection);
  if (!layout) return false;
  const { node, position, depth } = layout;
  const columnIndex = depth === null ? 0 : selection.$from.index(depth);
  let cursor = position;
  let blocks = Fragment.empty;
  node.forEach((column, _offset, index) => {
    if (index < columnIndex) cursor += column.content.size;
    blocks = blocks.append(column.content);
  });
  if (depth !== null && selection.$from.depth > depth && selection.$from.index(depth) < node.childCount) {
    cursor += selection.from - selection.$from.start(depth + 1);
  }

  return editor.chain().command(({ tr, dispatch }) => {
    const resolved = tr.doc.resolve(position);
    if (!resolved.parent.canReplace(resolved.index(), resolved.index() + 1, blocks)) return false;
    if (dispatch) {
      tr.replaceWith(position, position + node.nodeSize, blocks);
      tr.setSelection(TextSelection.near(tr.doc.resolve(cursor))).scrollIntoView();
    }
    return true;
  }).focus().run();
}
