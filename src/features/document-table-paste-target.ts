import type { Editor, EditorEvents } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { Selection } from '@tiptap/pm/state';
import { ySyncPluginKey, yUndoPluginKey } from '@tiptap/y-tiptap';
import { XmlElement } from 'yjs';
import { projectCollaborationBlocks } from '../../shared/collaboration-block-order';
import { MAX_DOCUMENT_BYTES, MAX_DOCUMENT_NODES } from '../../shared/document-nodes';
import type { RichContent } from '../../shared/types';

type InsertResult = 'inserted' | 'anchor' | 'size';

export function trackDocumentTableTarget(editor: Editor) {
  if (editor.isDestroyed || !editor.isEditable || editor.view.composing) return null;
  const { state } = editor;
  if (!state.doc.childCount) return null;
  const { $to, empty } = state.selection;
  const boundary = $to.depth > 0 ? $to.before(1) : empty ? $to.pos : Math.max(0, $to.pos - 1);
  const { node, offset, index } = state.doc.childAfter(Math.min(boundary, state.doc.content.size - 1));
  if (!node) return null;
  const initialEnd = offset + node.nodeSize;
  const sync = ySyncPluginKey.getState(state);
  if (sync?.snapshot || sync?.prevSnapshot) return null;
  let resolve: () => number | null;
  let stop = () => {};

  if (sync) {
    // A projected Yjs block keeps its identity as peer edits change its content or position.
    const anchor = projectCollaborationBlocks(sync.type)[index];
    if (!(anchor instanceof XmlElement) || sync.binding.mapping.get(anchor) !== node) return null;
    resolve = () => {
      const current = ySyncPluginKey.getState(editor.state);
      if (!current || current.type !== sync.type || current.snapshot || current.prevSnapshot) return null;
      const ordered = projectCollaborationBlocks(current.type);
      const target = ordered.indexOf(anchor);
      if (target < 0 || current.binding.mapping.get(anchor) !== editor.state.doc.maybeChild(target)) return null;
      let end = 0;
      for (let index = 0; index <= target; index++) end += editor.state.doc.child(index).nodeSize;
      return end;
    };
  } else {
    let start = offset;
    let end: number | null = initialEnd;
    let document = state.doc;
    const map = ({ transaction, appendedTransactions }: EditorEvents['transaction']) => {
      for (const change of [transaction, ...appendedTransactions]) {
        if (end === null) break;
        if (!change.docChanged) continue;
        if (change.before !== document || change.getMeta('preventUpdate')) {
          end = null;
          break;
        }
        const left = change.mapping.mapResult(start, 1);
        const right = change.mapping.mapResult(end, -1);
        const block = change.doc.childAfter(left.pos);
        if (left.deleted || right.deleted || block.offset !== left.pos || block.node?.type !== node.type ||
            block.offset + block.node.nodeSize !== right.pos) {
          end = null;
          break;
        }
        start = left.pos;
        end = right.pos;
        document = change.doc;
      }
    };
    editor.on('transaction', map);
    resolve = () => editor.state.doc === document ? end : null;
    stop = () => editor.off('transaction', map);
  }

  return {
    stop,
    insert(content: RichContent): InsertResult {
      if (editor.isDestroyed || !editor.isEditable || editor.view.composing) return 'anchor';
      const position = resolve();
      if (position === null) return 'anchor';
      const current = editor.state;
      const table = current.schema.nodeFromJSON(content);
      const point = current.doc.resolve(position);
      if (point.depth || !point.parent.canReplaceWith(point.index(), point.index(), table.type)) return 'anchor';
      const insertion = current.tr.insert(position, table);
      let nodes = 1;
      insertion.doc.descendants(() => ++nodes <= MAX_DOCUMENT_NODES);
      if (nodes > MAX_DOCUMENT_NODES || new TextEncoder().encode(JSON.stringify(insertion.doc.toJSON())).byteLength > MAX_DOCUMENT_BYTES) return 'size';

      const undoManager = yUndoPluginKey.getState(current)?.undoManager;
      undoManager?.stopCapturing();
      editor.view.dispatch(closeHistory(insertion.setSelection(Selection.near(insertion.doc.resolve(position + 1), 1)).scrollIntoView()));
      undoManager?.stopCapturing();
      return editor.state.doc !== current.doc ? 'inserted' : 'anchor';
    },
  };
}
