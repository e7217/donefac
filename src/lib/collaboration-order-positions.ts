import { Node } from '@tiptap/pm/model';
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, type SyncPluginState } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { projectCollaborationBlocks } from '../../shared/collaboration-block-order';

type BindingPositions = Pick<SyncPluginState, 'doc' | 'type' | 'binding'>;

function blockSpans({ type, binding }: BindingPositions) {
  const physical = type.toArray();
  const projected = projectCollaborationBlocks(type);
  if (physical.every((node, index) => node === projected[index])) return null;

  let start = 0;
  const physicalSpans = physical.map((node, index) => {
    const mapped = binding.mapping.get(node);
    const length = mapped instanceof Node ? mapped.nodeSize : 0;
    const span = { node, index, start, length };
    start += length;
    return span;
  });
  const byNode = new Map(physicalSpans.map(span => [span.node, span]));
  let projectedStart = 0;
  const spans = projected.flatMap(node => {
    const physicalSpan = byNode.get(node);
    if (!physicalSpan) return [];
    const span = { ...physicalSpan, projectedStart };
    projectedStart += span.length;
    return [span];
  });
  return { spans, projectedSize: projectedStart };
}

/** The binding stores real Yjs nodes. Translate only the offsets between top-level blocks. */
export function collaborationRelativePosition(position: number, sync: BindingPositions): Y.RelativePosition {
  const { type, binding } = sync;
  const order = blockSpans(sync);
  if (!order) return absolutePositionToRelativePosition(position, type, binding.mapping);
  if (position === order.projectedSize && order.spans.length) {
    return Y.createRelativePositionFromTypeIndex(type, order.spans[order.spans.length - 1].index + 1, -1);
  }
  const block = order.spans.find(span => position >= span.projectedStart && position < span.projectedStart + span.length);
  if (!block) throw new RangeError('공동 편집의 블록 위치를 확인할 수 없습니다.');
  if (position === block.projectedStart) return Y.createRelativePositionFromTypeIndex(type, block.index, 0);
  return absolutePositionToRelativePosition(block.start + position - block.projectedStart, type, binding.mapping);
}

export function collaborationAbsolutePosition(position: Y.RelativePosition, sync: BindingPositions): number | null {
  const { doc, type, binding } = sync;
  const order = blockSpans(sync);
  if (!order) return relativePositionToAbsolutePosition(doc, type, position, binding.mapping);
  const decoded = Y.createAbsolutePositionFromRelativePosition(position, doc);
  if (!decoded) return null;

  if (decoded.type === type) {
    const before = position.assoc >= 0;
    const physicalIndex = before ? decoded.index : decoded.index - 1;
    const block = order.spans.find(span => span.index === physicalIndex);
    return block ? block.projectedStart + (before ? 0 : block.length) : before ? order.projectedSize : 0;
  }
  // Yjs resolves positions in a text or nested node before we map into the visible order.
  let ancestor = decoded.type;
  while (ancestor.parent && ancestor.parent !== type) ancestor = ancestor.parent;
  if (ancestor.parent !== type) return null;
  const block = order.spans.find(span => span.node === ancestor);
  if (!block) return null;
  const physical = relativePositionToAbsolutePosition(doc, type, position, binding.mapping);
  if (physical === null || physical < block.start || physical > block.start + block.length) return null;
  return block.projectedStart + physical - block.start;
}
