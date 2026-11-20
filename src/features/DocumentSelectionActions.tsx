'use client';

import { useId } from 'react';
import { TextSelection } from '@tiptap/pm/state';
import { useEditorState, type Editor } from '@tiptap/react';
import { Link2, ListPlus, MessageSquarePlus } from 'lucide-react';
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

type OpenSelection = (range: DocumentSourceSelection, opener: HTMLButtonElement) => void;

export function DocumentSelectionActions({ editor, unavailable, issueUnavailable, onCreate, onLink, onComment }: {
  editor: Editor | null;
  unavailable: string | null;
  issueUnavailable: string | null;
  onCreate: OpenSelection;
  onLink: OpenSelection;
  onComment: OpenSelection;
}) {
  const hintId = useId();
  const issueHintId = useId();
  const selection = useEditorState({ editor, selector: ({ editor: instance }) => readSelection(instance) });
  const hint = selection?.state === 'invalid' ? `본문의 텍스트를 ${DOCUMENT_SELECTION_TEXT_LIMIT.toLocaleString('ko-KR')}자 이내로 선택해 주세요.`
    : selection?.state === 'ready' ? unavailable : null;
  const issueHint = selection?.state === 'ready' && !hint ? issueUnavailable : null;

  return <>
    {[
      { label: '선택한 본문에 댓글 남기기', Icon: MessageSquarePlus, open: onComment },
      { label: '선택한 본문으로 후속 업무 만들기', Icon: ListPlus, open: onCreate, requiresProject: true },
      { label: '선택한 본문을 기존 업무에 연결', Icon: Link2, open: onLink, requiresProject: true },
    ].map(({ label, Icon, open, requiresProject }) => {
      const blocked = unavailable || (requiresProject && issueUnavailable);
      const description = hint ? hintId : requiresProject && issueHint ? issueHintId : undefined;
      return <button key={label} type="button" className="btn docs-selection-action"
        disabled={selection?.state !== 'ready' || Boolean(blocked)} aria-describedby={description}
        onMouseDown={event => event.preventDefault()} onClick={event => {
          const current = readSelection(editor);
          if (current.state === 'ready' && !blocked) open(current.range, event.currentTarget);
        }}><Icon size={15} aria-hidden="true" />{label}</button>;
    })}
    {hint && <span id={hintId} className="docs-selection-action-hint" role="status">{hint}</span>}
    {issueHint && <span id={issueHintId} className="docs-selection-action-hint" role="status">{issueHint}</span>}
  </>;
}
