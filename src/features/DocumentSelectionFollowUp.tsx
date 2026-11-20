'use client';

import { useId } from 'react';
import { TextSelection } from '@tiptap/pm/state';
import { useEditorState, type Editor } from '@tiptap/react';
import { ListPlus } from 'lucide-react';
import { DOCUMENT_SELECTION_TEXT_LIMIT, documentSelectionText } from '../../shared/document-selection';
import type { DocumentSourceSelection } from '../../shared/types';

function readSelection(editor: Editor | null): { state: 'empty' | 'invalid' } | { state: 'ready'; range: DocumentSourceSelection } {
  if (!editor || editor.isDestroyed) return { state: 'empty' };
  const { doc, selection } = editor.state;
  if (!(selection instanceof TextSelection) || selection.empty) return { state: 'empty' };
  const { from, to } = selection;
  const text = documentSelectionText(doc, from, to);
  return text === null ? { state: 'invalid' } : { state: 'ready', range: { from, to, text } };
}

export function DocumentSelectionFollowUp({ editor, unavailable, onOpen }: {
  editor: Editor | null;
  unavailable: string | null;
  onOpen: (range: DocumentSourceSelection, opener: HTMLButtonElement) => void;
}) {
  const hintId = useId();
  const selection = useEditorState({ editor, selector: ({ editor: instance }) => readSelection(instance) });
  const hint = selection?.state === 'invalid' ? `본문의 텍스트를 ${DOCUMENT_SELECTION_TEXT_LIMIT.toLocaleString('ko-KR')}자 이내로 선택해 주세요.`
    : selection?.state === 'ready' ? unavailable : null;

  return <>
    <button type="button" className="btn docs-selection-follow-up" disabled={selection?.state !== 'ready' || Boolean(unavailable)}
      aria-describedby={hint ? hintId : undefined} onMouseDown={event => event.preventDefault()} onClick={event => {
        const current = readSelection(editor);
        if (current.state === 'ready' && !unavailable) onOpen(current.range, event.currentTarget);
      }}>
      <ListPlus size={15} aria-hidden="true" />선택한 본문으로 후속 업무 만들기
    </button>
    {hint && <span id={hintId} className="docs-selection-follow-up-hint" role="status">{hint}</span>}
  </>;
}
