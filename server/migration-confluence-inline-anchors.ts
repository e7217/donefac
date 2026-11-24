import { DOCUMENT_SELECTION_TEXT_LIMIT } from '../shared/document-selection.js';
import { createEditorSchema } from '../shared/editor-schema.js';
import type { DocumentSourceSelection, RichContent } from '../shared/types.js';

const boundary = Symbol('Confluence inline comment boundary');
type Boundary = { ref: string; side: 'from' | 'to' };
type TaggedNode = RichContent & { [boundary]?: Boundary[] };
type Extent = Partial<Omit<DocumentSourceSelection, 'text'>> & { parent?: RichContent; ambiguous?: true };
let schema: ReturnType<typeof createEditorSchema> | undefined;

/** Source ownership stays in the converter. Boundary tags never enter serialized document content. */
export class ConfluenceInlineAnchors {
  private readonly counts = new Map<string, number>();
  private readonly excerpts = new Map<string, string>();

  observe(ref: string | undefined): void {
    if (!ref || ref.length > 200 || ref.trim() !== ref || !ref.isWellFormed() || /\p{Cc}/u.test(ref)) return;
    this.counts.set(ref, (this.counts.get(ref) ?? 0) + 1);
  }

  capture(ref: string | undefined, nodes: TaggedNode[]): void {
    if (!ref || this.counts.get(ref) !== 1 || !nodes.length) return;
    let text = '';
    for (const node of nodes) {
      if (node.type === 'text') text += node.text;
      else if (node.type === 'hardBreak') text += '\n';
      else return;
      if (text.length > DOCUMENT_SELECTION_TEXT_LIMIT) return;
    }
    if (!text.trim() || !text.isWellFormed()) return;
    const first = nodes[0], last = nodes[nodes.length - 1];
    first[boundary] = [...(first[boundary] ?? []), { ref, side: 'from' }];
    last[boundary] = [...(last[boundary] ?? []), { ref, side: 'to' }];
    this.excerpts.set(ref, text);
  }

  selections(projection: RichContent): ReadonlyMap<string, DocumentSourceSelection> | undefined {
    if (!this.excerpts.size) return;
    const { nodes } = schema ??= createEditorSchema();
    const positions = new Map<string, Extent>();
    function visit(node: TaggedNode, position: number, parent?: RichContent): number {
      let end = position + 1;
      if (node.type === 'text') end = position + node.text!.length;
      else if (!nodes[node.type].isLeaf) {
        for (const child of node.content ?? []) end = visit(child, end, node);
        end++;
      }
      for (const { ref, side } of node[boundary] ?? []) {
        const extent = positions.get(ref) ?? { parent };
        if (extent[side] !== undefined || extent.parent !== parent) extent.ambiguous = true;
        extent[side] = side === 'from' ? position : end;
        positions.set(ref, extent);
      }
      return end;
    }
    // Canonicalization may merge identical adjacent text marks. It preserves their combined text size.
    visit(projection, -1);
    const selections = new Map<string, DocumentSourceSelection>();
    for (const [ref, { from, to, ambiguous }] of positions) {
      const text = this.excerpts.get(ref);
      if (!ambiguous && text !== undefined && from !== undefined && to !== undefined && from < to) {
        selections.set(ref, { from, to, text });
      }
    }
    return selections.size ? selections : undefined;
  }
}
