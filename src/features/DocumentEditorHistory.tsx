'use client';

import { useEditorState, type Editor } from '@tiptap/react';
import { Redo2, Undo2 } from 'lucide-react';

export function DocumentEditorHistory({ editor, disabled }: { editor: Editor | null; disabled: boolean }) {
  const available = useEditorState({ editor, selector: ({ editor: instance }) => {
    if (!instance || instance.isDestroyed || !instance.isEditable) return null;
    const commands = instance.can();
    return { undo: commands.undo(), redo: commands.redo() };
  } });

  function applyHistory(action: 'undo' | 'redo') {
    if (disabled || !editor || editor.isDestroyed || !editor.isEditable || editor.view.composing) return;
    if (editor.commands[action]()) editor.view.focus();
  }

  return <>
    <button type="button" className="docs-format-btn docs-history-control" title="실행 취소" aria-label="실행 취소"
      aria-keyshortcuts="Control+Z Meta+Z" disabled={disabled || !available?.undo}
      onMouseDown={event => event.preventDefault()} onClick={() => applyHistory('undo')}>
      <Undo2 size={15} aria-hidden="true" />
    </button>
    <button type="button" className="docs-format-btn docs-history-control" title="다시 실행" aria-label="다시 실행"
      aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y Meta+Y" disabled={disabled || !available?.redo}
      onMouseDown={event => event.preventDefault()} onClick={() => applyHistory('redo')}>
      <Redo2 size={15} aria-hidden="true" />
    </button>
  </>;
}
