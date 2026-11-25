'use client';

import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { closeHistory } from '@tiptap/pm/history';
import { CellSelection } from '@tiptap/pm/tables';
import { useEditorState, type Editor } from '@tiptap/react';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { collaborationBlockMoveCapacity } from '../../shared/collaboration-block-order';
import { moveCollaborationEditorBlock } from '../lib/collaboration-order-binding';

function activeBlock(editor: Editor | null) {
  if (!editor || editor.isDestroyed || !editor.isEditable || editor.view.composing) return null;
  const { doc, selection } = editor.state;
  if (!(selection instanceof TextSelection || selection instanceof NodeSelection || selection instanceof CellSelection)) return null;
  if (selection instanceof TextSelection && (!selection.$anchor.parent.inlineContent || !selection.$head.parent.inlineContent)) return null;
  const start = selection instanceof CellSelection ? Math.min(selection.$anchorCell.pos, selection.$headCell.pos) : selection.from;
  const end = selection instanceof CellSelection ? Math.max(selection.$anchorCell.pos, selection.$headCell.pos) : selection.to;
  const { node, offset, index } = doc.childAfter(start);
  if (!node || end > offset + node.nodeSize || (start === offset && !(selection instanceof NodeSelection))) return null;
  const blankParagraph = editor.schema.nodes.paragraph.create();
  let lastIndex = doc.childCount - 1;
  // Keep the editor's final empty input paragraphs after the authored blocks.
  while (lastIndex >= 0 && doc.child(lastIndex).eq(blankParagraph)) lastIndex--;
  if (index > lastIndex) return null;
  return { doc, node, offset, index, lastIndex, selection };
}

function moveBlock(editor: Editor, direction: -1 | 1, collaborative: boolean) {
  const block = activeBlock(editor);
  if (!block) return;
  const { doc, node, offset, index, lastIndex, selection } = block;
  if (index + direction > lastIndex) return;
  const neighbor = doc.maybeChild(index + direction);
  if (!neighbor) return;
  if (collaborative) {
    if (moveCollaborationEditorBlock(editor, index, index + direction)) editor.view.focus();
    return;
  }
  const end = offset + node.nodeSize;
  const destination = direction < 0 ? offset - neighbor.nodeSize : end + neighbor.nodeSize;
  const { tr, storedMarks } = editor.state;
  tr.delete(offset, end);
  const insertion = tr.mapping.map(destination);
  tr.insert(insertion, node);

  // Moving an intact node keeps its nested content and attributes. Keep the selection's offset inside it.
  const shift = insertion - offset;
  const moved = selection instanceof NodeSelection ? NodeSelection.create(tr.doc, selection.anchor + shift)
    : selection instanceof CellSelection ? CellSelection.create(tr.doc, selection.$anchorCell.pos + shift, selection.$headCell.pos + shift)
    : TextSelection.create(tr.doc, selection.anchor + shift, selection.head + shift);
  editor.view.dispatch(closeHistory(tr.setSelection(moved).setStoredMarks(storedMarks).scrollIntoView()));
  editor.view.focus();
}

export function DocumentBlockOrder({ editor, collaborative }: { editor: Editor; collaborative: boolean }) {
  const available = useEditorState({ editor, selector: ({ editor: instance }) => {
    const block = activeBlock(instance);
    if (!block || block.lastIndex < 1) return null;
    const sync = collaborative && instance ? ySyncPluginKey.getState(instance.state) : undefined;
    const atLimit = Boolean(sync && !collaborationBlockMoveCapacity(sync.type));
    return { up: !atLimit && block.index > 0, down: !atLimit && block.index < block.lastIndex, atLimit };
  } });
  if (!available) return null;

  return <span role="group" aria-label="본문 블록 순서">
    <button type="button" className="btn docs-selection-action" aria-label="블록 위로 이동" disabled={!available.up}
      onMouseDown={event => event.preventDefault()} onClick={() => moveBlock(editor, -1, collaborative)}>
      <ArrowUp size={15} aria-hidden="true" />블록 위로
    </button>
    <button type="button" className="btn docs-selection-action" aria-label="블록 아래로 이동" disabled={!available.down}
      onMouseDown={event => event.preventDefault()} onClick={() => moveBlock(editor, 1, collaborative)}>
      <ArrowDown size={15} aria-hidden="true" />블록 아래로
    </button>
    {available.atLimit && <span role="status">이 문서의 블록 이동 기록이 한도에 도달했습니다.</span>}
  </span>;
}
