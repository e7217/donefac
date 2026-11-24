'use client';

import { useId } from 'react';
import { TextSelection } from '@tiptap/pm/state';
import { useEditorState, type Editor } from '@tiptap/react';
import { Link2, ListPlus, MessageSquarePlus } from 'lucide-react';
import { DOCUMENT_SELECTION_TEXT_LIMIT, documentSelectionText } from '../../shared/document-selection';
import type { DocumentSourceSelection } from '../../shared/types';

type SelectionState = { state: 'empty' | 'invalid' } | { state: 'ready'; range: DocumentSourceSelection };

function readSelection(editor: Editor | null): SelectionState {
  if (!editor || editor.isDestroyed) return { state: 'empty' };
  const { doc, selection } = editor.state;
  if (!(selection instanceof TextSelection) || selection.empty) return { state: 'empty' };
  const { from, to } = selection;
  const text = documentSelectionText(doc, from, to);
  return text === null ? { state: 'invalid' } : { state: 'ready', range: { from, to, text } };
}

function readChecklistItem(editor: Editor | null): SelectionState {
  if (!editor || editor.isDestroyed) return { state: 'empty' };
  const { doc, selection } = editor.state;
  if (!(selection instanceof TextSelection) || !selection.empty) return { state: 'empty' };
  const { $from } = selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const item = $from.node(depth);
    if (item.type.name !== 'taskItem') continue;
    // The item's first paragraph identifies it. Notes and nested checklist items stay outside the quote.
    const paragraph = item.firstChild;
    if (paragraph?.type.name !== 'paragraph') return { state: 'invalid' };
    const from = $from.start(depth) + 1;
    const to = from + paragraph.content.size;
    const text = documentSelectionText(doc, from, to);
    return text === null ? { state: 'invalid' } : { state: 'ready', range: { from, to, text } };
  }
  return { state: 'empty' };
}

type OpenSelection = (range: DocumentSourceSelection, opener: HTMLButtonElement) => void;

export function DocumentSelectionActions({ editor, unavailable, issueUnavailable, onCreate, onLink, onComment,
  onCreateChecklist, checklistReselecting, onCancelChecklistReselect,
}: {
  editor: Editor | null;
  unavailable: string | null;
  issueUnavailable: string | null;
  onCreate: OpenSelection;
  onLink: OpenSelection;
  onComment: OpenSelection;
  onCreateChecklist: OpenSelection;
  checklistReselecting?: boolean;
  onCancelChecklistReselect?: () => void;
}) {
  const hintId = useId();
  const issueHintId = useId();
  const checklistHintId = useId();
  const current = useEditorState({ editor, selector: ({ editor: instance }) => ({
    selection: readSelection(instance), checklist: readChecklistItem(instance),
  }) });
  const selection = current?.selection;
  const checklist = current?.checklist;
  const hint = selection?.state === 'invalid' ? `본문의 텍스트를 ${DOCUMENT_SELECTION_TEXT_LIMIT.toLocaleString('ko-KR')}자 이내로 선택해 주세요.`
    : selection?.state === 'ready' ? unavailable : null;
  const issueHint = selection?.state === 'ready' && !hint ? issueUnavailable : null;
  const checklistBlocked = unavailable || issueUnavailable;
  const showChecklist = checklistReselecting || (checklist && checklist.state !== 'empty');
  const checklistHint = checklist?.state === 'invalid' ? `첫 문단에 ${DOCUMENT_SELECTION_TEXT_LIMIT.toLocaleString('ko-KR')}자 이내의 본문이 있는 체크리스트 항목을 선택해 주세요.`
    : checklist?.state === 'ready' ? checklistBlocked
      : checklistReselecting ? '다시 사용할 체크리스트 항목에 커서를 두세요.' : null;
  const checklistActions = checklistReselecting ? [{ label: '이 체크리스트 항목 사용', Icon: ListPlus, open: onCreateChecklist }] : [
    { label: '체크리스트 항목으로 후속 업무 만들기', Icon: ListPlus, open: onCreateChecklist },
    { label: '체크리스트 항목을 기존 업무에 연결', Icon: Link2, open: onLink },
  ];

  return <>
    {!checklistReselecting && <>
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
    </>}
    {showChecklist && <>
      {checklistActions.map(({ label, Icon, open }) => <button key={label} type="button" className="btn docs-selection-action"
        disabled={checklist?.state !== 'ready' || Boolean(checklistBlocked)} aria-describedby={checklistHint ? checklistHintId : undefined}
        onMouseDown={event => event.preventDefault()} onClick={event => {
          const item = readChecklistItem(editor);
          if (item.state === 'ready' && !checklistBlocked) open(item.range, event.currentTarget);
        }}><Icon size={15} aria-hidden="true" />{label}</button>)}
      {checklistReselecting && onCancelChecklistReselect && <button type="button" className="btn docs-selection-action"
        onClick={onCancelChecklistReselect}>항목 다시 선택 취소</button>}
      {checklistHint && <span id={checklistHintId} className="docs-selection-action-hint" role="status">{checklistHint}</span>}
    </>}
  </>;
}
