'use client';

import { useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react';
import type { Editor } from '@tiptap/react';
import type { SelectionBookmark, Transaction } from '@tiptap/pm/state';
import { ListFilter, SlidersHorizontal, X } from 'lucide-react';
import {
  DOCUMENT_ISSUE_LIST_LIMIT, ISSUE_SUMMARY_GROUP_LABELS, MAX_DOCUMENT_ISSUE_BLOCKS,
  isIssueSummaryGroupBy, type DocumentIssueList as IssueListAttrs, type IssueSummaryGroupBy,
} from '../../shared/document-nodes';
import { projectIssueSchema } from '../../shared/issue-schema';
import { createIssueViewMatcher } from '../../shared/issue-view';
import type { Issue, WorkspaceSnapshot } from '../../shared/types';
import { statusMeta } from '../../shared/workflow-helpers';

type IssueBlockType = 'issueList' | 'issueSummary';
type IssueBlockAttrs = IssueListAttrs & { groupBy?: IssueSummaryGroupBy };
type IssueBlockTarget = { getPos: () => number | undefined; attrs: IssueBlockAttrs };
export type OpenIssueBlock = (editor: Editor, nodeType: IssueBlockType, target?: IssueBlockTarget) => void;
type IssueBlockSelectionBase = { editor: Editor; documentId: string; opener: HTMLElement | null; nodeType: IssueBlockType };
export type IssueBlockSelection = IssueBlockSelectionBase & (
  { kind: 'insert'; bookmark: SelectionBookmark } |
  { kind: 'edit'; target: IssueBlockTarget }
);

export function issueListAttrs(attrs: Record<string, unknown> | undefined): IssueListAttrs {
  return {
    projectId: typeof attrs?.projectId === 'string' ? attrs.projectId : '',
    savedViewId: typeof attrs?.savedViewId === 'string' ? attrs.savedViewId : null,
    label: typeof attrs?.label === 'string' ? attrs.label : '',
  };
}

function issueBlockAttrs(nodeType: IssueBlockType, raw: Record<string, unknown>): IssueBlockAttrs {
  const attrs = issueListAttrs(raw);
  return nodeType === 'issueSummary' ? { ...attrs, groupBy: isIssueSummaryGroupBy(raw.groupBy) ? raw.groupBy : 'status' } : attrs;
}

function sameIssueBlock(a: IssueBlockAttrs, b: IssueBlockAttrs) {
  return a.projectId === b.projectId && a.savedViewId === b.savedViewId && a.label === b.label && a.groupBy === b.groupBy;
}

export function keepDocumentSelection(event: MouseEvent<HTMLButtonElement>) {
  event.preventDefault();
  event.stopPropagation();
}

export function IssueListCard({ data, attrs, openIssue, limit = DOCUMENT_ISSUE_LIST_LIMIT, onEdit, onDelete }: {
  data: WorkspaceSnapshot;
  attrs: IssueListAttrs;
  openIssue: (id: string) => void;
  limit?: number;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const project = data.projects.find(item => item.id === attrs.projectId);
  const savedView = data.savedViews?.find(item => item.projectId === attrs.projectId && item.id === attrs.savedViewId);
  const unavailable = !project ? '프로젝트를 찾을 수 없습니다.' : attrs.savedViewId && !savedView ? '공유 보기를 찾을 수 없습니다.' : '';
  const label = !unavailable && project ? `${project.name} · ${savedView?.name ?? '전체 업무'}` : attrs.label || '업무 목록';
  const listId = useId();
  const { issues, count } = useMemo(() => {
    const issues: Issue[] = [];
    let count = 0;
    if (!unavailable) {
      const match = savedView ? createIssueViewMatcher(savedView.filters, data, projectIssueSchema(data, attrs.projectId)) : null;
      for (const issue of data.issues) {
        if (issue.projectId !== attrs.projectId || match && !match(issue)) continue;
        if (issues.length < limit) issues.push(issue);
        count++;
      }
    }
    return { issues, count };
  }, [unavailable, savedView, data, attrs.projectId, limit]);
  const people = useMemo(() => new Map(data.users.map(person => [person.id, person.name])), [data.users]);

  return <section className="doc-issue-list" aria-label="업무 목록">
    <header className="doc-issue-list-heading">
      <ListFilter aria-hidden="true" size={16} />
      <div className="doc-issue-list-caption"><small>업무 목록</small><strong>{label}</strong></div>
      {!unavailable && <span className="doc-issue-list-count">{count.toLocaleString('ko-KR')}개</span>}
      {onEdit && onDelete && <div className="doc-issue-list-actions">
        <button type="button" className="btn btn-ghost docs-icon-button" title="업무 목록 설정" aria-label="업무 목록 설정" onMouseDown={keepDocumentSelection} onClick={event => { event.stopPropagation(); onEdit(); }}><SlidersHorizontal size={14} /></button>
        <button type="button" className="btn btn-ghost docs-icon-button" title="업무 목록 삭제" aria-label="업무 목록 삭제" onMouseDown={keepDocumentSelection} onClick={event => { event.stopPropagation(); onDelete(); }}><X size={14} /></button>
      </div>}
    </header>
    {unavailable ? <p className="doc-issue-list-message">{unavailable}</p> : count === 0 ? <p className="doc-issue-list-message">조건에 맞는 업무가 없습니다.</p> : <>
      <ul className="doc-issue-list-rows">
        {issues.map((issue, index) => {
          const status = statusMeta(data, issue.projectId, issue.status);
          const assignee = issue.assigneeId ? people.get(issue.assigneeId) : undefined;
          const statusId = `${listId}-status-${index}`, assigneeId = `${listId}-assignee-${index}`;
          return <li key={issue.id}>
            <button type="button" className="doc-issue-list-row" aria-label={`목록 업무 열기 ${issue.key} ${issue.title}`} aria-describedby={`${statusId} ${assigneeId}`} onMouseDown={keepDocumentSelection} onClick={event => { event.stopPropagation(); openIssue(issue.id); }}>
              <span className="doc-issue-list-name"><small>{issue.key}</small><strong>{issue.title}</strong></span>
              <span className="doc-issue-list-status" id={statusId}><i style={{ backgroundColor: status.color }} aria-hidden="true" />{status.label}</span>
              <span className="doc-issue-list-assignee" id={assigneeId}>{assignee ?? '미지정'}</span>
            </button>
          </li>;
        })}
      </ul>
      {count > issues.length && <p className="doc-issue-list-message">전체 {count.toLocaleString('ko-KR')}개 중 {issues.length}개 표시</p>}
    </>}
  </section>;
}

export function IssueBlockChooser({ selection, data, preferredProjectId, onClose }: {
  selection: IssueBlockSelection;
  data: WorkspaceSnapshot;
  preferredProjectId: string | null;
  onClose: () => void;
}) {
  const [projectId, setProjectId] = useState(() => selection.kind === 'edit' ? selection.target.attrs.projectId : preferredProjectId ?? data.projects[0]?.id ?? '');
  const [savedViewId, setSavedViewId] = useState(() => selection.kind === 'edit' ? selection.target.attrs.savedViewId ?? '' : '');
  const [groupBy, setGroupBy] = useState<IssueSummaryGroupBy>(() => selection.kind === 'edit' ? selection.target.attrs.groupBy ?? 'status' : 'status');
  const [error, setError] = useState('');
  const projectSelect = useRef<HTMLSelectElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const restoreFocus = useRef(true);
  const bookmark = useRef(selection.kind === 'insert' ? selection.bookmark : null);
  const { editor, nodeType } = selection;
  const isSummary = nodeType === 'issueSummary';
  const blockLabel = isSummary ? '업무 현황' : '업무 목록';
  const project = data.projects.find(item => item.id === projectId);
  const views = data.savedViews?.filter(item => item.projectId === projectId) ?? [];
  const view = views.find(item => item.id === savedViewId);
  const title = `${blockLabel} ${selection.kind === 'edit' ? '설정' : '삽입'}`;

  useLayoutEffect(() => {
    const map = ({ transaction }: { transaction: Transaction }) => { if (bookmark.current) bookmark.current = bookmark.current.map(transaction.mapping); };
    editor.on('transaction', map);
    projectSelect.current?.focus();
    return () => {
      editor.off('transaction', map);
      if (restoreFocus.current) requestAnimationFrame(() => { if (selection.opener?.isConnected) selection.opener.focus(); });
    };
  }, [editor, selection.opener]);

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!project || savedViewId && !view) return;
    if (editor.isDestroyed || !editor.isEditable) { setError('현재 편집할 문서를 다시 확인해 주세요.'); return; }
    const source: IssueListAttrs = { projectId, savedViewId: view?.id ?? null, label: `${project.name} · ${view?.name ?? '전체 업무'}`.slice(0, 300) };
    const attrs = isSummary ? { ...source, groupBy } : source;
    try {
      if (selection.kind === 'edit') {
        const { target } = selection;
        const position = target.getPos();
        const previous = position === undefined ? null : editor.state.doc.nodeAt(position);
        if (position === undefined || previous?.type.name !== nodeType || !sameIssueBlock(issueBlockAttrs(nodeType, previous.attrs), target.attrs)) {
          setError(`${blockLabel} 블록이 변경되었거나 삭제되었습니다. 최신 블록에서 다시 열어 주세요.`);
          return;
        }
        if (!sameIssueBlock(attrs, target.attrs)) editor.view.dispatch(editor.state.tr.setNodeMarkup(position, undefined, attrs));
      } else {
        if (!bookmark.current) throw new Error('삽입할 위치를 다시 선택해 주세요.');
        let blockCount = 0;
        editor.state.doc.descendants(node => { if (node.type.name === 'issueList' || node.type.name === 'issueSummary') blockCount++; });
        if (blockCount >= MAX_DOCUMENT_ISSUE_BLOCKS) throw new Error(`업무 목록과 업무 현황은 문서당 합계 ${MAX_DOCUMENT_ISSUE_BLOCKS}개까지 추가할 수 있습니다.`);
        const position = bookmark.current.resolve(editor.state.doc);
        const placed = editor.chain().command(({ tr }) => { tr.setSelection(position); return true; })
          .insertContent([{ type: nodeType, attrs }, { type: 'paragraph' }]).run();
        if (!placed) throw new Error(`이 위치에는 ${blockLabel} 블록을 넣을 수 없습니다.`);
        restoreFocus.current = false;
        requestAnimationFrame(() => { if (!editor.isDestroyed && editor.isEditable) editor.view.focus(); });
      }
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : `${blockLabel} 블록을 적용하지 못했습니다.`); }
  }

  function keyboard(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); return; }
    if (event.key !== 'Tab') return;
    const focusable = form.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled)');
    if (!focusable?.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  return <div className="doc-reference-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <form ref={form} role="dialog" aria-modal="true" aria-label={title} className="doc-reference-chooser doc-issue-list-chooser" onSubmit={apply} onKeyDown={keyboard}>
      <header><div><h3>{title}</h3><p>{isSummary ? '프로젝트나 공유 보기의 업무 수를 선택한 기준으로 집계합니다.' : '프로젝트 전체 업무 또는 공유 보기에 해당하는 업무를 표시합니다.'}</p></div><button type="button" className="btn btn-ghost" aria-label={`${blockLabel} 닫기`} onClick={onClose}><X size={16} /></button></header>
      <div className="doc-issue-list-fields">
        <label>프로젝트<select ref={projectSelect} className="field" aria-label={`${blockLabel} 프로젝트`} value={projectId} onChange={event => { setProjectId(event.target.value); setSavedViewId(''); setError(''); }}>
          {!project && <option value={projectId} disabled>{projectId ? '찾을 수 없는 프로젝트' : '프로젝트를 선택하세요.'}</option>}
          {data.projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <label>공유 보기<select className="field" aria-label={`${blockLabel} 공유 보기`} disabled={!project} value={savedViewId} onChange={event => { setSavedViewId(event.target.value); setError(''); }}>
          <option value="">프로젝트 전체 업무</option>
          {savedViewId && !view && <option value={savedViewId} disabled>찾을 수 없는 공유 보기</option>}
          {views.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        {isSummary && <label>그룹 기준<select className="field" aria-label="업무 현황 그룹 기준" value={groupBy} onChange={event => { const value = event.target.value; if (isIssueSummaryGroupBy(value)) setGroupBy(value); setError(''); }}>
          {Object.entries(ISSUE_SUMMARY_GROUP_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>}
        {error && <p role="alert">{error}</p>}
      </div>
      <footer><button type="button" className="btn btn-ghost" onClick={onClose}>취소</button><button type="submit" className="btn btn-primary" disabled={!project || Boolean(savedViewId && !view)}>{selection.kind === 'edit' ? `${blockLabel} 적용` : title}</button></footer>
    </form>
  </div>;
}
