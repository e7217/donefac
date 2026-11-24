'use client';

import { useId } from 'react';
import { TextSelection } from '@tiptap/pm/state';
import { useEditorState, type Editor } from '@tiptap/react';
import { ChevronRight, Link2, ListPlus, MessageSquarePlus } from 'lucide-react';
import { DOCUMENT_SELECTION_TEXT_LIMIT, documentChecklistItemSelection, documentSelectionText } from '../../shared/document-selection';
import { issueDeadline } from '../../shared/my-work';
import type { DocumentChecklistWork, DocumentSourceSelection, Issue, WorkspaceSnapshot } from '../../shared/types';
import { statusMeta } from '../../shared/workflow-helpers';
import './document-checklist-work.css';

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
    const range = documentChecklistItemSelection(doc, item, $from.before(depth));
    return range ? { state: 'ready', range } : { state: 'invalid' };
  }
  return { state: 'empty' };
}

type OpenSelection = (range: DocumentSourceSelection, opener: HTMLButtonElement) => void;
type ChecklistWork = { links: DocumentChecklistWork['links']; data: WorkspaceSnapshot; openIssue: (id: string) => void };

function sameRange(left: DocumentSourceSelection, right: DocumentSourceSelection): boolean {
  return left.from === right.from && left.to === right.to && left.text === right.text;
}

function checklistIssues(work: ChecklistWork, range: DocumentSourceSelection): Issue[] {
  const confirmed = work.links.filter(({ sourceSelection }) => sameRange(sourceSelection, range));
  if (!confirmed.length) return [];
  const activeLinks = new Map(work.data.resourceLinks.map(link => [link.id, link]));
  const activeIssues = new Map(work.data.issues.map(issue => [issue.id, issue]));
  const matches = new Map<string, Issue>();
  for (const { linkId, issueId, sourceSelection } of confirmed) {
    const link = activeLinks.get(linkId);
    const issue = activeIssues.get(issueId);
    if (issue && link?.issueId === issueId && link.documentSource && sameRange(link.documentSource, sourceSelection)) {
      matches.set(issueId, issue);
    }
  }
  return [...matches.values()];
}

export function DocumentSelectionActions({ editor, unavailable, issueUnavailable, onCreate, onLink, onComment,
  onCreateChecklist, checklistReselecting, onCancelChecklistReselect, checklistWork, onShowDocumentLinks,
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
  checklistWork?: ChecklistWork;
  onShowDocumentLinks?: () => void;
}) {
  const hintId = useId();
  const issueHintId = useId();
  const checklistHintId = useId();
  const checklistWorkId = useId();
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
  const activeChecklist = !checklistReselecting && !checklistBlocked && checklist?.state === 'ready' ? checklist.range : null;
  const issues = activeChecklist && checklistWork ? checklistIssues(checklistWork, activeChecklist) : [];

  return <>
    {!showChecklist && <>
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
      {activeChecklist && checklistWork && issues.length > 0 && <section className="docs-checklist-work" aria-labelledby={checklistWorkId}>
        <h3 id={checklistWorkId}>연결된 체크리스트 업무</h3>
        <ul className="docs-checklist-work-list" role="list">{issues.map((issue, index) => {
          const status = statusMeta(checklistWork.data, issue.projectId, issue.status);
          const assignee = checklistWork.data.users.find(user => user.id === issue.assigneeId)?.name;
          const deadline = issueDeadline(issue);
          const descriptionId = `${checklistWorkId}-${index}`;
          return <li key={issue.id}><button type="button" className="docs-linked-issue" aria-label={`${issue.key} 업무 열기`}
            aria-describedby={descriptionId} onMouseDown={event => event.preventDefault()} onClick={event => {
              const item = readChecklistItem(editor);
              if (item.state !== 'ready' || !sameRange(item.range, activeChecklist)) return;
              event.currentTarget.focus({ preventScroll: true });
              checklistWork.openIssue(issue.id);
            }}>
            <span className="docs-linked-issue-key">{issue.key}<ChevronRight size={12} aria-hidden="true" /></span>
            <span id={descriptionId}>
              <strong>{issue.title}</strong>
              <span className="docs-linked-issue-meta">
                <span className="docs-linked-issue-status"><i style={{ backgroundColor: status.color }} aria-hidden="true" />{status.label}</span>
                <span>{assignee || '담당자 미지정'}</span>
                <span>{deadline ? <>{deadline.source === 'dueDate' ? '목표 마감일' : '계획 종료일'} <time dateTime={deadline.value}>{deadline.value}</time></> : '기한 없음'}</span>
              </span>
            </span>
          </button></li>;
        })}</ul>
      </section>}
      {activeChecklist && !issues.length && onShowDocumentLinks && <button type="button" className="btn docs-selection-action"
        onMouseDown={event => event.preventDefault()} onClick={() => {
          const item = readChecklistItem(editor);
          if (item.state === 'ready' && sameRange(item.range, activeChecklist)) onShowDocumentLinks();
        }}>문서에 연결된 업무 보기</button>}
    </>}
  </>;
}
