import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { isStatusBadgeLabel } from './document-nodes.js';
import { documentSelectionText } from './document-selection.js';
import { createEditorSchema } from './editor-schema.js';
import type { DocumentSourceSelection, RichContent } from './types.js';

export type DocumentSelectionMark = { kind: 'text'; from: number; to: number } | { kind: 'badge' };
export type DocumentSelectionHighlight = { marks: ReadonlyMap<string, DocumentSelectionMark>; anchor: string };

let schema: ReturnType<typeof createEditorSchema> | undefined;

/** Map recorded ProseMirror positions to the original JSON paths used by the read-only renderer. */
export function locateDocumentSelection(content: RichContent, selection: DocumentSourceSelection): DocumentSelectionHighlight | null {
  try {
    const { from, to, text } = selection;
    const documentSchema = schema ??= createEditorSchema();
    const document = documentSchema.nodeFromJSON(content);
    if (document.type !== documentSchema.topNodeType || typeof text !== 'string' || documentSelectionText(document, from, to) !== text) return null;
    document.check();

    const marks = new Map<string, DocumentSelectionMark>();
    function visit(node: ProseMirrorNode, raw: RichContent, position: number, path: string): boolean {
      if (raw.type !== node.type.name) return false;
      const children = raw.content === undefined ? [] : raw.content;
      // ProseMirror can merge adjacent text with the same marks. The renderer keeps their original indices.
      if (!Array.isArray(children) || children.length !== node.childCount) return false;
      if (node.isText) {
        if (typeof raw.text !== 'string' || raw.text !== node.text) return false;
        const start = Math.max(0, from - position);
        const end = Math.min(raw.text.length, to - position);
        if (!raw.text.slice(start, end).isWellFormed()) return false;
        marks.set(path, { kind: 'text', from: start, to: end });
      } else if (node.type.name === 'statusBadge') {
        const label = raw.attrs?.label;
        if (!isStatusBadgeLabel(label) || label !== node.attrs.label) return false;
        marks.set(path, { kind: 'badge' });
      }

      let childPosition = position + 1;
      for (let index = 0; index < node.childCount && childPosition < to; index++) {
        const child = node.child(index);
        const end = childPosition + child.nodeSize;
        if (end > from && !visit(child, children[index], childPosition, `${path}:${index}`)) return false;
        childPosition = end;
      }
      return true;
    }
    // The top node has no opening token. Its first child starts at position 0.
    if (!visit(document, content, -1, 'readonly')) return null;
    const anchor = marks.keys().next().value;
    return anchor === undefined ? null : { marks, anchor };
  } catch {
    return null;
  }
}
