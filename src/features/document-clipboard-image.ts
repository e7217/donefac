import type { Editor, EditorEvents } from '@tiptap/core';
import { Fragment, Slice } from '@tiptap/pm/model';
import { closeHistory } from '@tiptap/pm/history';
import { Selection, TextSelection } from '@tiptap/pm/state';
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ySyncPluginKey, yUndoPluginKey } from '@tiptap/y-tiptap';
import { compareRelativePositions, createAbsolutePositionFromRelativePosition, XmlElement, XmlText } from 'yjs';

export function clipboardImageFiles(clipboard: DataTransfer): File[] {
  if (clipboard.getData('text/plain') || clipboard.getData('text/html') || clipboard.getData('text/uri-list')) return [];
  const files = Array.from(clipboard.files);
  const candidates = files.length ? files : Array.from(clipboard.items, item => item.getAsFile()).filter(file => file !== null);
  return candidates.every(file => file.type.startsWith('image/')) ? candidates : [];
}

type ClipboardImage = { src: string; alt: string };

export function trackClipboardImagePosition(editor: Editor) {
  const { state } = editor;
  const { $to } = state.selection;
  if (!$to.parent.isTextblock || $to.parent.type.spec.code) return null;
  const start = $to.pos;
  const blockType = $to.parent.type;
  const sync = ySyncPluginKey.getState(state);
  if (sync?.snapshot || sync?.prevSnapshot) return null;
  let resolve: () => number | null;
  let stop = () => {};

  if (sync) {
    // A remote Yjs update can replace the entire ProseMirror projection. Resolve within the original Yjs block.
    try {
      const anchor = absolutePositionToRelativePosition(start, sync.type, sync.binding.mapping);
      const type = createAbsolutePositionFromRelativePosition(anchor, sync.doc)?.type;
      const block = type instanceof XmlText ? type.parent : type;
      if (!(block instanceof XmlElement) || sync.binding.mapping.get(block) !== $to.parent) return null;
      resolve = () => {
        const current = ySyncPluginKey.getState(editor.state);
        if (!current || current.doc !== sync.doc || current.snapshot || current.prevSnapshot) return null;
        const position = relativePositionToAbsolutePosition(current.doc, current.type, anchor, current.binding.mapping);
        if (position === null || current.binding.mapping.get(block) !== editor.state.doc.resolve(position).parent) return null;
        const resolved = absolutePositionToRelativePosition(position, current.type, current.binding.mapping);
        return compareRelativePositions(anchor, resolved) ? position : null;
      };
    } catch {
      return null;
    }
  } else {
    let position: number | null = start;
    let trackedDocument = state.doc;
    const mapPosition = ({ transaction, appendedTransactions }: EditorEvents['transaction']) => {
      for (const change of [transaction, ...appendedTransactions]) {
        if (position === null) break;
        if (!change.docChanged) continue;
        if (change.before !== trackedDocument || change.getMeta('preventUpdate')) {
          position = null;
          break;
        }
        const from = change.before.resolve(position);
        const mapped = change.mapping.mapResult(position, -1);
        const blockOpening = change.mapping.mapResult(from.start() - 1, 1);
        const blockClosing = change.mapping.mapResult(from.end() + 1, -1);
        if (mapped.deleted || blockOpening.deleted || blockClosing.deleted) {
          position = null;
          break;
        }
        const next = change.doc.resolve(mapped.pos);
        position = next.parent.type === blockType && next.start() - 1 === blockOpening.pos && next.end() + 1 === blockClosing.pos ? mapped.pos : null;
        trackedDocument = change.doc;
      }
    };
    editor.on('transaction', mapPosition);
    stop = () => editor.off('transaction', mapPosition);
    resolve = () => trackedDocument === editor.state.doc ? position : null;
  }

  return {
    stop,
    insert(images: ClipboardImage[]): boolean {
      if (!images.length || editor.isDestroyed || !editor.isEditable) return false;
      try {
        const position = resolve();
        if (position === null) return false;
        const { state: current } = editor;
        const nodes = images.map(image => current.schema.nodes.image.create(image));
        const insertion = current.tr.replaceRange(position, position, new Slice(Fragment.fromArray(nodes), 0, 0));
        if (!insertion.docChanged) return false;
        const expected = new Set(images.map(image => image.src));
        let lastImageEnd = 0;
        insertion.doc.descendants((node, at) => {
          if (node.type === current.schema.nodes.image && expected.delete(node.attrs.src)) lastImageEnd = at + node.nodeSize;
        });
        if (expected.size) return false;
        if (editor.isFocused && current.selection.empty && current.selection.from === position) {
          const after = insertion.doc.resolve(lastImageEnd);
          const paragraph = current.schema.nodes.paragraph;
          if ((!after.nodeAfter?.isTextblock || after.nodeAfter.type.spec.code) &&
              after.parent.canReplaceWith(after.index(), after.index(), paragraph)) {
            insertion.insert(lastImageEnd, paragraph.create());
          }
          const next = Selection.findFrom(insertion.doc.resolve(lastImageEnd), 1, true);
          if (next instanceof TextSelection) insertion.setSelection(next).scrollIntoView();
        }
        const undo = yUndoPluginKey.getState(current)?.undoManager;
        undo?.stopCapturing();
        editor.view.dispatch(closeHistory(insertion));
        undo?.stopCapturing();
        return editor.state.doc !== current.doc;
      } catch {
        return false;
      }
    },
  };
}
