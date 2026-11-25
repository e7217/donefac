'use client';

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react';
import type { Editor, JSONContent } from '@tiptap/react';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { SelectionBookmark, Transaction } from '@tiptap/pm/state';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { ListFilter, SlidersHorizontal, X } from 'lucide-react';
import type { ConfluenceJiraList } from '../../shared/confluence-jira-list';
import {
  DOCUMENT_ISSUE_LIST_LIMIT, ISSUE_SUMMARY_GROUP_LABELS, MAX_DOCUMENT_ISSUE_BLOCKS,
  isIssueSummaryGroupBy, type DocumentIssueList as IssueListAttrs, type IssueSummaryGroupBy,
} from '../../shared/document-nodes';
import { projectIssueSchema } from '../../shared/issue-schema';
import { createIssueViewMatcher, orderIssueView } from '../../shared/issue-view';
import type { FeatureProps, SavedView, WorkspaceSnapshot } from '../../shared/types';
import { statusMeta } from '../../shared/workflow-helpers';
import { JiraSavedViewDialog } from './JiraSavedViewDialog';
import { insertDocumentSlashBlocks, restoreDocumentSlashFocus, useDocumentSlashRange, type DocumentSlashAnchor } from './document-slash-insertion';

type IssueBlockType = 'issueList' | 'issueSummary';
type IssueBlockAttrs = IssueListAttrs & { groupBy?: IssueSummaryGroupBy };
type IssueBlockTarget = { getPos: () => number | undefined; attrs: IssueBlockAttrs };
export type OpenIssueBlock = (editor: Editor, nodeType: IssueBlockType, target?: IssueBlockTarget, slash?: DocumentSlashAnchor) => void;
type IssueBlockSelectionBase = { editor: Editor; documentId: string; opener: HTMLElement | null; nodeType: IssueBlockType };
export type IssueBlockSelection = IssueBlockSelectionBase & (
  { kind: 'insert'; bookmark: SelectionBookmark; slash?: DocumentSlashAnchor } |
  { kind: 'edit'; target: IssueBlockTarget } |
  { kind: 'restoreJira'; nodeType: 'issueList'; target: { pos: number; node: ProseMirrorNode; macro: ConfluenceJiraList } }
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

export function matchingDocumentIssues(data: WorkspaceSnapshot, projectId: string, savedView: SavedView | undefined, actorId?: string) {
  const match = savedView ? createIssueViewMatcher(savedView.filters, data, projectIssueSchema(data, projectId), actorId) : null;
  const matching = data.issues.filter(issue => issue.projectId === projectId && (!match || match(issue)));
  const projectOrder = data.issueOrders?.find(candidate => candidate.projectId === projectId);
  return orderIssueView(matching, projectOrder, savedView?.sort);
}

export function IssueListCard({ data, attrs, actorId, openIssue, limit = DOCUMENT_ISSUE_LIST_LIMIT, onEdit, onDelete }: {
  data: WorkspaceSnapshot;
  attrs: IssueListAttrs;
  actorId?: string;
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
    if (unavailable) return { issues: [], count: 0 };
    const matching = matchingDocumentIssues(data, attrs.projectId, savedView, actorId);
    return { issues: matching.slice(0, limit), count: matching.length };
  }, [unavailable, savedView, data, attrs.projectId, actorId, limit]);
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

const staleRestoreSource = '원본 Jira 블록이 변경되었거나 삭제되었습니다. 현재 문서에서 다시 열어 주세요.';

function identicalNodePosition(document: ProseMirrorNode, original: ProseMirrorNode): number | null {
  let position: number | null = null;
  let repeated = false;
  document.descendants((node, at) => {
    if (!repeated && node === original) {
      if (position === null) position = at;
      else repeated = true;
    }
    return !repeated;
  });
  return repeated ? null : position;
}

function mapRestorePosition(transaction: Transaction, position: number, original: ProseMirrorNode) {
  let start = position;
  let end = start + original.nodeSize;
  for (const step of transaction.mapping.maps) {
    const from = step.mapResult(start, 1);
    const to = step.mapResult(end, -1);
    if (from.deleted || to.deleted) {
      // Yjs may replace the whole document projection. Reused node identity can still prove which block survived.
      return transaction.getMeta(ySyncPluginKey)?.isChangeOrigin ? identicalNodePosition(transaction.doc, original) : null;
    }
    start = from.pos;
    end = to.pos;
  }
  return end - start === original.nodeSize && transaction.doc.nodeAt(start)?.eq(original) ? start : null;
}

export function IssueBlockChooser({ selection, data, preferredProjectId, actorId, notify, refreshWorkspace, onClose }: {
  selection: IssueBlockSelection;
  preferredProjectId: string | null;
  refreshWorkspace: FeatureProps['refresh'];
  onClose: () => void;
} & Pick<FeatureProps, 'data' | 'actorId' | 'notify'>) {
  const restoringJira = selection.kind === 'restoreJira';
  const macro = restoringJira ? selection.target.macro : null;
  const [projectId, setProjectId] = useState(() => {
    if (selection.kind === 'restoreJira') return '';
    if (selection.kind === 'edit') return selection.target.attrs.projectId;
    return preferredProjectId ?? data.projects[0]?.id ?? '';
  });
  const [savedViewId, setSavedViewId] = useState(() => selection.kind === 'edit' ? selection.target.attrs.savedViewId ?? '' : '');
  const [groupBy, setGroupBy] = useState<IssueSummaryGroupBy>(() => selection.kind === 'edit' ? selection.target.attrs.groupBy ?? 'status' : 'status');
  const [error, setError] = useState('');
  const [jiraOpen, setJiraOpen] = useState(false);
  const [restoredView, setRestoredView] = useState<SavedView | null>(null);
  const [viewReload, setViewReload] = useState<'loading' | 'error' | 'ready'>('ready');
  const [sourceStale, setSourceStale] = useState(false);
  const projectSelect = useRef<HTMLSelectElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const restoreFocus = useRef(true);
  const bookmark = useRef(selection.kind === 'insert' && !selection.slash ? selection.bookmark : null);
  const sourcePosition = useRef(restoringJira ? selection.target.pos : null);
  const viewReloading = useRef(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const jiraButton = useRef<HTMLButtonElement>(null);
  const applyButton = useRef<HTMLButtonElement>(null);
  const reloadButton = useRef<HTMLButtonElement>(null);
  const { editor, nodeType } = selection;
  const slash = selection.kind === 'insert' ? selection.slash : undefined;
  const resolveSlashRange = useDocumentSlashRange(editor, slash);
  const isSummary = nodeType === 'issueSummary';
  const blockLabel = isSummary ? '업무 현황' : '업무 목록';
  const project = data.projects.find(item => item.id === projectId);
  const views = data.savedViews?.filter(item => item.projectId === projectId) ?? [];
  const view = views.find(item => item.id === savedViewId);
  const title = restoringJira ? 'Jira 업무 목록 복원' : `${blockLabel} ${selection.kind === 'edit' ? '설정' : '삽입'}`;
  const savedViewChanged = Boolean(restoredView && view && (view.version !== restoredView.version || view.authorId !== restoredView.authorId));
  const canRestoreJira = Boolean(!sourceStale && restoredView && view && !savedViewChanged && viewReload === 'ready');
  const needsViewReload = Boolean(restoredView && viewReload !== 'loading' && (viewReload === 'error' || !view));

  useLayoutEffect(() => {
    if (selection.kind === 'restoreJira' && editor.state.doc.nodeAt(selection.target.pos) !== selection.target.node) {
      sourcePosition.current = identicalNodePosition(editor.state.doc, selection.target.node);
      setSourceStale(sourcePosition.current === null);
    }
    const map = ({ transaction }: { transaction: Transaction }) => {
      if (bookmark.current) bookmark.current = bookmark.current.map(transaction.mapping);
      if (selection.kind !== 'restoreJira' || !transaction.docChanged || sourcePosition.current === null) return;
      sourcePosition.current = mapRestorePosition(transaction, sourcePosition.current, selection.target.node);
      if (sourcePosition.current === null) setSourceStale(true);
    };
    editor.on('transaction', map);
    projectSelect.current?.focus();
    return () => {
      editor.off('transaction', map);
      if (restoreFocus.current) requestAnimationFrame(() => { if (selection.opener?.isConnected) selection.opener.focus(); });
    };
  }, [editor, selection]);

  useEffect(() => {
    if (!restoredView || jiraOpen || viewReload === 'loading') return;
    const frame = requestAnimationFrame(() => {
      (canRestoreJira ? applyButton.current : needsViewReload ? reloadButton.current : closeButton.current)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [canRestoreJira, jiraOpen, needsViewReload, restoredView, viewReload]);

  async function reloadSavedView() {
    if (viewReloading.current) return;
    viewReloading.current = true;
    setViewReload('loading');
    try {
      await refreshWorkspace();
      setViewReload('ready');
    } catch { setViewReload('error'); }
    finally { viewReloading.current = false; }
  }

  function acceptJiraView(saved: SavedView) {
    if (saved.projectId !== projectId) return;
    setJiraOpen(false);
    setRestoredView(saved);
    setSavedViewId(saved.id);
    setError('');
    void reloadSavedView();
  }

  function closeJiraReview() {
    setJiraOpen(false);
    requestAnimationFrame(() => {
      const opener = jiraButton.current;
      (opener && !opener.disabled ? opener : closeButton.current)?.focus();
    });
  }

  function focusEditorAfterApply() {
    restoreFocus.current = false;
    requestAnimationFrame(() => { if (!editor.isDestroyed && editor.isEditable) editor.view.focus(); });
  }

  function cancel() {
    if (slash) restoreFocus.current = false;
    onClose();
    if (slash) restoreDocumentSlashFocus(editor);
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!project || savedViewId && !view) return;
    if (restoringJira && !canRestoreJira) return;
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
        let blockCount = 0;
        editor.state.doc.descendants(node => { if (node.type.name === 'issueList' || node.type.name === 'issueSummary') blockCount++; });
        if (blockCount >= MAX_DOCUMENT_ISSUE_BLOCKS) throw new Error(`업무 목록과 업무 현황은 문서당 합계 ${MAX_DOCUMENT_ISSUE_BLOCKS}개까지 추가할 수 있습니다.`);
        if (selection.kind === 'restoreJira') {
          const state = editor.state;
          const position = sourcePosition.current;
          const previous = position !== null && position >= 0 && position + selection.target.node.nodeSize <= state.doc.content.size
            ? state.doc.nodeAt(position) : null;
          if (position === null || !previous?.eq(selection.target.node)) {
            setSourceStale(true);
            sourcePosition.current = null;
            return;
          }
          const at = state.doc.resolve(position);
          const index = at.index();
          const list = state.schema.nodes.issueList;
          if (!list || index >= at.parent.childCount || !at.parent.child(index).eq(previous) ||
              !at.parent.canReplaceWith(index, index + 1, list)) throw new Error('이 위치에는 업무 목록을 넣을 수 없습니다.');
          const replacement = list.create(attrs);
          const transaction = state.tr.replaceWith(position, position + previous.nodeSize, replacement);
          if (!transaction.doc.nodeAt(position)?.eq(replacement)) throw new Error('원본 Jira 블록을 바꾸지 못했습니다.');
          sourcePosition.current = null;
          editor.view.dispatch(transaction);
        } else {
          const content: JSONContent[] = [{ type: nodeType, attrs }, { type: 'paragraph' }];
          let placed: boolean;
          if (slash) {
            const range = resolveSlashRange();
            if (!range) throw new Error('슬래시 명령이 변경되었습니다. 편집 위치를 다시 선택해 주세요.');
            placed = insertDocumentSlashBlocks(editor, range, content);
          } else {
            if (!bookmark.current) throw new Error('삽입할 위치를 다시 선택해 주세요.');
            const position = bookmark.current.resolve(editor.state.doc);
            placed = editor.chain().command(({ tr }) => { tr.setSelection(position); return true; }).insertContent(content).run();
          }
          if (!placed) throw new Error(`이 위치에는 ${blockLabel} 블록을 넣을 수 없습니다.`);
        }
        if (slash) restoreFocus.current = false;
        else focusEditorAfterApply();
      }
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : `${blockLabel} 블록을 적용하지 못했습니다.`); }
  }

  function keyboard(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); return; }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); return; }
    if (event.key !== 'Tab') return;
    const focusable = form.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled)');
    if (!focusable?.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  return <><div className="doc-reference-backdrop" inert={jiraOpen} onMouseDown={event => { if (event.target === event.currentTarget) cancel(); }}>
    <form ref={form} role="dialog" aria-modal="true" aria-label={title} className="doc-reference-chooser doc-issue-list-chooser" onSubmit={apply} onKeyDown={keyboard}>
      <header><div><h3>{title}</h3><p>{restoringJira ? '원본 업무를 옮긴 프로젝트를 선택하고 Jira 조건을 검토합니다.' : isSummary ? '프로젝트나 공유 보기의 업무 수를 선택한 기준으로 집계합니다.' : '프로젝트 전체 업무 또는 공유 보기에 해당하는 업무를 표시합니다.'}</p></div><button ref={closeButton} type="button" className="btn btn-ghost" aria-label={`${blockLabel} 닫기`} onClick={cancel}><X size={16} /></button></header>
      <div className="doc-issue-list-fields">
        {macro && <div className="doc-jira-restore-source"><strong>원본 Jira 검색식</strong>
          <pre>{macro.jql}</pre>
          {macro.server && <p>원본 Jira 연결 <strong>{macro.server}</strong></p>}
          {macro.columns && <p>원본 표시 열 {macro.columns}</p>}
          {macro.maximumIssues !== undefined && <p>원본 표시 한도 {macro.maximumIssues}개</p>}
          <p>Teamspace 업무 목록은 최대 {DOCUMENT_ISSUE_LIST_LIMIT}개 업무의 키, 제목, 상태와 담당자를 표시합니다.</p>
        </div>}
        <label>프로젝트<select ref={projectSelect} className="field" aria-label={`${blockLabel} 프로젝트`} value={projectId}
          disabled={restoringJira && (Boolean(restoredView) || sourceStale)}
          onChange={event => { setProjectId(event.target.value); setSavedViewId(''); setError(''); }}>
          {!project && <option value={projectId} disabled>{projectId ? '찾을 수 없는 프로젝트' : '프로젝트를 선택하세요.'}</option>}
          {data.projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        {!restoringJira && <label>공유 보기<select className="field" aria-label={`${blockLabel} 공유 보기`} disabled={!project} value={savedViewId} onChange={event => { setSavedViewId(event.target.value); setError(''); }}>
          <option value="">프로젝트 전체 업무</option>
          {savedViewId && !view && <option value={savedViewId} disabled>찾을 수 없는 공유 보기</option>}
          {views.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>}
        {restoredView && <p role="status">공유 보기 <strong>{restoredView.name}</strong>를 저장했습니다. 프로젝트의 공유 보기에서 열 수 있습니다.</p>}
        {viewReload === 'loading' && <p role="status">저장한 공유 보기를 불러오는 중입니다.</p>}
        {needsViewReload && <div className="doc-jira-restore-retry"><p role="alert">저장한 공유 보기를 불러오지 못했습니다.</p>
          <button ref={reloadButton} type="button" className="btn" onClick={() => void reloadSavedView()}>저장된 보기 다시 불러오기</button></div>}
        {savedViewChanged && <p role="alert">저장한 공유 보기가 변경되었습니다. 현재 문서에서 다시 열어 주세요.</p>}
        {sourceStale && <p role="alert">{staleRestoreSource}</p>}
        {isSummary && <label>그룹 기준<select className="field" aria-label="업무 현황 그룹 기준" value={groupBy} onChange={event => { const value = event.target.value; if (isIssueSummaryGroupBy(value)) setGroupBy(value); setError(''); }}>
          {Object.entries(ISSUE_SUMMARY_GROUP_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>}
        {error && <p role="alert">{error}</p>}
      </div>
      <footer><button type="button" className="btn btn-ghost" onClick={cancel}>취소</button>
        {restoringJira && !restoredView && <button ref={jiraButton} type="button" className="btn" disabled={!project || sourceStale}
          onClick={() => setJiraOpen(true)}>Jira 조건 검토</button>}
        <button ref={applyButton} type="submit" className="btn btn-primary" disabled={!project || (restoringJira ? !canRestoreJira : Boolean(savedViewId && !view))}>
          {restoringJira ? '원본을 업무 목록으로 바꾸기' : selection.kind === 'edit' ? `${blockLabel} 적용` : title}
        </button></footer>
    </form>
  </div>{jiraOpen && project && macro && <JiraSavedViewDialog actorId={actorId} notify={notify} project={project} currentLayout="list"
    initialQuery={macro.jql} onClose={closeJiraReview} onSaved={acceptJiraView} />}</>;
}
