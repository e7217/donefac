'use client';

import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type Editor, type JSONContent, type NodeViewProps } from '@tiptap/react';
import { Fragment } from '@tiptap/pm/model';
import { TextSelection, type SelectionBookmark, type Transaction } from '@tiptap/pm/state';
import type { AnyExtension, NodeViewRenderer } from '@tiptap/core';
import { ArrowLeft, ChevronDown, ChevronRight, FileClock, FileText, Link2, Search, X } from 'lucide-react';
import type { DocPage, DocRevision, DocumentSourceSelection, RichContent, WorkspaceSnapshot } from '../../shared/types';
import { contentReferences, DOCUMENT_ISSUE_LIST_LIMIT, documentColumnLayoutTracks, documentPlainText, findDocumentExcerpt, isDocumentHeadingLevel, isLiveDocumentInclude, MAX_DOCUMENT_TABLE_SPAN, normalizeDocumentColumnLayoutOptions } from '../../shared/document-nodes';
import { normalizeDocumentChildListOptions, projectDocumentChildren } from '../../shared/document-child-list';
import { normalizeDocumentLabelListOptions } from '../../shared/document-label-list';
import { collectDocumentPropertyReport, documentPropertyReportProjectIds, normalizeDocumentPropertiesOptions, normalizeDocumentPropertyReportOptions } from '../../shared/document-properties';
import { isDocumentSectionId, outlineHeadingTitle } from '../../shared/document-sections';
import type { DocumentSelectionHighlight } from '../../shared/document-selection-highlight';
import { attachmentDownloadIdFromUrl, inlineAttachmentIdFromUrl } from '../../shared/inline-attachment';
import { issueSearchText } from '../../shared/issue-schema';
import { statusMeta } from '../../shared/workflow-helpers';
import { issueSearchAliasLabel, searchIssueCandidates } from '../../shared/workspace-search';
import { api, ApiError } from '../lib/api';
import { IssueListCard, issueListAttrs, type OpenIssueBlock } from './DocumentIssueList';
import { IssueSummaryCard, issueSummaryAttrs } from './DocumentIssueSummary';
import { DocumentLabelListCard } from './DocumentLabelList';
import { DocumentChildListCard } from './DocumentChildList';
import { DocumentPropertiesCard, DocumentPropertyReportCard } from './DocumentProperties';
import { DocumentOutline, jumpToReadonlyHeading, revealDocumentTarget, type DocumentOutlineEntry } from './DocumentOutline';
import { ReadonlyCallout, ReadonlyStatusBadge, decorateDocumentAnnotation } from './DocumentAnnotations';
import { DocumentTocNodeView, ReadonlyDocumentToc } from './DocumentToc';
import { documentColumnLayoutEditingPlugin, exitDocumentColumnLayout } from './document-column-layout';
import { insertDocumentSlashBlocks, restoreDocumentSlashFocus, useDocumentSlashRange, type DocumentSlashAnchor } from './document-slash-insertion';
import { documentRevisionLabel } from './document-utils';
import './document-blocks.css';
import './document-column-layout.css';

export type ReferenceKind = 'issueReference' | 'documentReference' | 'documentInclude' | 'documentRevisionInclude' | 'documentExcerptInclude';
export type ReferenceSelection = {
  kind: ReferenceKind; editor: Editor; bookmark: SelectionBookmark; documentId: string; slash?: DocumentSlashAnchor;
};
const MAX_INCLUDE_DEPTH = 5, TOTAL_INCLUDE_NODES = 4000;
type Context = {
  data: WorkspaceSnapshot;
  documentId: string | null;
  openIssue: (id: string) => void;
  openDocument: (id: string) => void;
  openIssueBlock?: OpenIssueBlock;
  onListDraftChange?: (id: string, dirty: boolean) => void;
  editorReadOnly: boolean;
  includeBudget: number;
};
const BlockContext = createContext<Context | null>(null);
type DocumentBlocksProviderProps = Omit<Context, 'includeBudget' | 'editorReadOnly'> & {
  content?: RichContent;
  editorReadOnly?: boolean;
  children: ReactNode;
};
export function DocumentBlocksProvider({ data, documentId, content, openIssue, openDocument, openIssueBlock, onListDraftChange,
  editorReadOnly = true, children }: DocumentBlocksProviderProps) {
  const count = content ? contentReferences(content).filter(reference => reference.kind === 'include').length : 0;
  const value = useMemo(() => ({ data, documentId, openIssue, openDocument, openIssueBlock, onListDraftChange,
    editorReadOnly, includeBudget: Math.floor(TOTAL_INCLUDE_NODES / Math.max(1, count)) }),
    [data, documentId, openIssue, openDocument, openIssueBlock, onListDraftChange, editorReadOnly, count]);
  return <BlockContext.Provider value={value}>{children}</BlockContext.Provider>;
}
function contextOf(value: Context | null): Context { if (!value) throw new Error('문서 블록을 표시할 문맥이 없습니다.'); return value; }
function textAttr(node: RichContent, name: string) { return typeof node.attrs?.[name] === 'string' ? node.attrs[name] as string : ''; }
function issueCard(context: Context, id: string, label: string, key?: string, previewReference = false) {
  const issue = context.data.issues.find(item => item.id === id), meta = issue ? statusMeta(context.data, issue.projectId, issue.status) : null;
  return <button key={key} type="button" className={`doc-reference-card issue ${issue ? '' : 'is-missing'}`} disabled={!issue} data-preview-issue-reference={previewReference && issue ? '' : undefined} aria-label={issue ? `참조 업무 열기 ${issue.key} ${issue.title}` : `찾을 수 없는 업무 ${label || id}`} onMouseDown={event => { event.preventDefault(); event.stopPropagation(); }} onClick={event => { event.stopPropagation(); if (issue) context.openIssue(issue.id); }}><span className="doc-reference-icon"><Link2 size={15} /></span><span><small>{issue?.key || '찾을 수 없는 업무'}</small><strong>{issue?.title || label || id}</strong></span>{meta && <em style={{ color: meta.color }}><i style={{ background: meta.color }} />{meta.label}</em>}</button>;
}
function documentCard(context: Context, id: string, label: string, included = false, key?: string) {
  const document = context.data.documents.find(item => item.id === id);
  return <button key={key} type="button" className={`doc-reference-card document ${document ? '' : 'is-missing'}`} disabled={!document} aria-label={document ? `${included ? '포함 문서 원본' : '참조 문서'} 열기 ${document.title}` : `찾을 수 없는 문서 ${label || id}`} onMouseDown={event => { event.preventDefault(); event.stopPropagation(); }} onClick={event => { event.stopPropagation(); if (document) context.openDocument(document.id); }}><span className="doc-reference-icon"><FileText size={15} /></span><span><small>{included ? '마지막으로 불러온 원본 · 읽기 전용' : '문서 참조'}</small><strong>{document?.title || label || id}</strong>{!document && <small>삭제되었거나 찾을 수 없는 문서입니다.</small>}</span><ChevronRight size={14} /></button>;
}
function Notice({ children }: { children: ReactNode }) { return <span className="doc-include-notice" role="note">{children}</span>; }
function safeUrl(value: unknown, image = false): string | undefined {
  if (typeof value !== 'string') return;
  if (/^\/(?!\/)/.test(value) || !image && /^#[^\u0000-\u001f]*$/.test(value)) return value;
  try { const url = new URL(value); if ((['https:', 'http:'].includes(url.protocol) || !image && ['mailto:', 'tel:'].includes(url.protocol)) && !url.username && !url.password) return value; } catch { /* Untrusted content stays text when the URL is invalid. */ }
}
type PinnedSource = { documentId: string; revisionId: string };
type RenderedExcerpt = DocumentSelectionHighlight & { anchorRendered: boolean };
type RenderState = { documentId: string | null; remaining: number; exhausted: boolean; visited: Set<string>; includeDepth: number; structuralDepth: number; mode?: 'history' | 'pinned' | 'preview'; pinnedSource?: PinnedSource; outline: DocumentOutlineEntry[]; section?: { id: string; target?: string }; referenceIssueId?: string; excerpt?: RenderedExcerpt };

function headingTitle(node: RichContent) {
  return outlineHeadingTitle(documentPlainText(node));
}

export function containsDocumentNavigation(node: RichContent): boolean {
  if (node.type === 'documentToc') return true;
  if (node.type === 'heading') return headingTitle(node).length > 0;
  return node.content?.some(containsDocumentNavigation) ?? false;
}

type RevisionRequest = { controller: AbortController; readers: number; result: Promise<DocRevision> };
const revisionRequests = new Map<string, RevisionRequest>();
const includeRevisionPath = (documentId: string) => `/documents/${encodeURIComponent(documentId)}/include-revisions`;

function subscribeToRevision(documentId: string, revisionId: string) {
  const path = `${includeRevisionPath(documentId)}/${encodeURIComponent(revisionId)}`;
  let request = revisionRequests.get(path);
  if (!request) {
    const controller = new AbortController();
    const created: RevisionRequest = { controller, readers: 0, result: api<DocRevision>(path, { signal: controller.signal }).finally(() => {
      if (revisionRequests.get(path) === created) revisionRequests.delete(path);
    }) };
    request = created;
    revisionRequests.set(path, created);
  }
  const activeRequest = request;
  activeRequest.readers++;
  return { result: activeRequest.result, release() {
    if (--activeRequest.readers === 0 && revisionRequests.get(path) === activeRequest) {
      revisionRequests.delete(path);
      activeRequest.controller.abort();
    }
  } };
}

type RevisionLoad = { revision: DocRevision; excerpt?: DocumentSelectionHighlight | null; quote?: string } | { error: string; missing: boolean };
function PinnedRevision({ documentId, revisionId, label, nodeBudget, sourceLabel, selection, loadSelection, expectedVersion, actionLabel }: {
  documentId: string;
  revisionId: string;
  label: string;
  nodeBudget: number;
  sourceLabel?: string;
  selection?: DocumentSourceSelection;
  loadSelection?: (signal: AbortSignal) => Promise<DocumentSourceSelection>;
  expectedVersion?: number;
  actionLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<RevisionLoad | null>(null);
  const toggleButton = useRef<HTMLButtonElement>(null);
  const openingFocus = useRef<Element | null>(null);
  const excerptRequested = selection !== undefined || loadSelection !== undefined;
  const { from, to, text: excerptText } = selection ?? {};
  const canRevealExcerpt = useCallback(() => {
    const active = document.activeElement;
    return active !== null && (active === toggleButton.current || active === openingFocus.current);
  }, []);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let releaseRevision: (() => void) | undefined;
    async function load() {
      const retrieved = loadSelection ? await loadSelection(controller.signal) : undefined;
      if (controller.signal.aborted) return;
      const subscription = subscribeToRevision(documentId, revisionId);
      releaseRevision = subscription.release;
      const revision = await subscription.result;
      if (controller.signal.aborted) return;
      if (revision.id !== revisionId || revision.documentId !== documentId ||
          (expectedVersion !== undefined && revision.version !== expectedVersion)) {
        setLoaded({ error: '고정 버전 정보를 확인할 수 없습니다.', missing: false });
        return;
      }
      const selected = retrieved ?? (from !== undefined && to !== undefined && excerptText !== undefined ? { from, to, text: excerptText } : undefined);
      let excerpt: DocumentSelectionHighlight | null | undefined;
      if (excerptRequested) {
        excerpt = selected ? await import('../../shared/document-selection-highlight').then(
          ({ locateDocumentSelection }) => locateDocumentSelection(revision.content, selected),
          () => null,
        ) : null;
      }
      if (!controller.signal.aborted) setLoaded({ revision, excerpt, quote: retrieved?.text });
    }
    void load().catch(error => {
      if (controller.signal.aborted) return;
      const missing = error instanceof ApiError && error.status === 404;
      setLoaded({ error: missing ? '고정 버전을 찾을 수 없습니다.' : '고정 버전을 불러오지 못했습니다.', missing });
    });
    return () => { controller.abort(); releaseRevision?.(); };
  }, [documentId, revisionId, open, attempt, excerptRequested, from, to, excerptText, loadSelection, expectedVersion]);

  useEffect(() => {
    const imported = () => { setOpen(false); setLoaded(null); };
    window.addEventListener('teamspace:workspace-imported', imported);
    return () => window.removeEventListener('teamspace:workspace-imported', imported);
  }, []);

  const saved = loaded && 'revision' in loaded ? loaded : undefined;
  const revision = saved?.revision;
  const revisionLabel = revision?.confluenceSourceVersion != null ? documentRevisionLabel(revision) : revision ? `고정 버전 ${revision.version}` : '고정 버전';
  const title = revision?.title || label || '제목 없는 문서';
  const toggleLabel = actionLabel ? `${actionLabel} ${open ? '접기' : '열기'}`
    : sourceLabel ? (open ? '원문 저장본 접기' : '원문 저장본 열기') : (open ? '고정 버전 내용 접기' : '고정 버전 내용 보기');
  return <section className="doc-included-content doc-pinned-include" aria-label={`${sourceLabel ?? '고정 포함 문서'} ${title}`}
    onKeyDown={event => {
      if (!open || !excerptRequested || event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setLoaded(null);
      openingFocus.current = null;
      toggleButton.current?.focus();
    }}>
    <button ref={toggleButton} type="button" className="doc-reference-card document" aria-expanded={open}
      aria-label={toggleLabel} onClick={() => { openingFocus.current = open ? null : document.activeElement; setLoaded(null); setOpen(!open); }}>
      <span className="doc-reference-icon"><FileClock size={15} aria-hidden="true" /></span>
      <span><small>{revisionLabel}</small><strong>{title}</strong></span>
      {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
    </button>
    {open && !loaded && <p className="doc-pinned-message" role="status">고정 버전을 불러오는 중…</p>}
    {open && loaded && 'error' in loaded && <div className="doc-pinned-message"><p role="alert">{loaded.error}</p>
      {!loaded.missing && <button className="btn btn-ghost" type="button" onClick={() => { setLoaded(null); setAttempt(previous => previous + 1); }}>고정 버전 다시 불러오기</button>}
    </div>}
    {open && saved?.quote && <blockquote aria-label="결정 근거 발췌">{saved.quote}</blockquote>}
    {open && revision && <ReadonlyDocumentContent content={revision.content} documentId={documentId} nodeBudget={nodeBudget} mode="pinned"
      pinnedSource={{ documentId, revisionId }} showOutline={Boolean(sourceLabel)} selectionHighlight={saved?.excerpt} canRevealExcerpt={canRevealExcerpt} />}
  </section>;
}

const keepReading = () => {};

export function DocumentDecisionRevision({ data, documentId, revisionId, label, sourceLabel = '결정 근거 원문', selection, loadSelection, expectedVersion, actionLabel }: {
  data: WorkspaceSnapshot;
  documentId: string;
  revisionId: string;
  label: string;
  sourceLabel?: string;
  selection?: DocumentSourceSelection;
  loadSelection?: (signal: AbortSignal) => Promise<DocumentSourceSelection>;
  expectedVersion?: number;
  actionLabel?: string;
}) {
  return <DocumentBlocksProvider data={data} documentId={documentId} openIssue={keepReading} openDocument={keepReading}>
    <PinnedRevision documentId={documentId} revisionId={revisionId} label={label} nodeBudget={30_000} sourceLabel={sourceLabel} selection={selection}
      loadSelection={loadSelection} expectedVersion={expectedVersion} actionLabel={actionLabel} />
  </DocumentBlocksProvider>;
}

function pinnedRevision(id: string, revision: string, label: string, budget: number, key: string) {
  return <PinnedRevision key={JSON.stringify([key, id, revision])} documentId={id} revisionId={revision} label={label} nodeBudget={budget} />;
}

function revisionAttachmentUrl(pinned: PinnedSource, kind: 'images' | 'files', attachmentId: string) {
  return `/api${includeRevisionPath(pinned.documentId)}/${encodeURIComponent(pinned.revisionId)}/${kind}/${encodeURIComponent(attachmentId)}`;
}

function imageUrl(raw: unknown, pinned?: PinnedSource) {
  if (pinned) {
    const attachmentId = inlineAttachmentIdFromUrl(raw);
    if (attachmentId) return revisionAttachmentUrl(pinned, 'images', attachmentId);
  }
  return safeUrl(raw, true);
}

function renderIncluded(context: Context, id: string, label: string, state: RenderState, key: string, {
  excerpt = false, noPanel = false,
}: { excerpt?: boolean; noPanel?: boolean } = {}): ReactNode {
  const document = context.data.documents.find(item => item.id === id);
  if (!document) return <Notice key={key}>포함 문서를 찾을 수 없습니다: {label || id}</Notice>;
  if (state.visited.has(id)) return <Notice key={key}>순환 문서 포함을 중단했습니다: {document.title}</Notice>;
  if (state.includeDepth >= MAX_INCLUDE_DEPTH) return <Notice key={key}>문서 포함 깊이 제한(5단계)에 도달했습니다: {document.title}</Notice>;
  const definition = excerpt ? findDocumentExcerpt(document.content) : undefined;
  if (excerpt && !definition) return <Notice key={key}>발췌 구역을 찾을 수 없습니다: {document.title}</Notice>;
  const next = { ...state, documentId: id, visited: new Set([...state.visited, id]), includeDepth: state.includeDepth + 1, outline: [], section: undefined, excerpt: undefined, pinnedSource: undefined };
  const body: RichContent = definition ? { type: 'doc', content: definition.content } : document.content;
  const rendered = renderNode(body, context, next, `${key}:body`);
  state.remaining = next.remaining; state.exhausted = next.exhausted;
  return <section className={`doc-included-content${noPanel ? ' is-panel-hidden' : ''}`} key={key}
    aria-label={`${excerpt ? '발췌한 문서' : '포함된 문서'} ${document.title}`}>
    {!noPanel && documentCard(context, id, label, true)}
    <div className="doc-readonly-content" data-document-outline-root="">{rendered}
      {state.includeDepth === 0 && state.exhausted && <Notice>포함된 내용이 많거나 구조가 깊어 표시 한도에 도달했습니다. 원본 문서에서 이어서 확인하세요.</Notice>}
    </div>
  </section>;
}
function excerptMark(content: ReactNode, state: RenderState, key: string) {
  const anchor = state.excerpt?.anchor === key;
  if (state.excerpt && anchor) state.excerpt.anchorRendered = true;
  return <mark data-document-excerpt="" data-document-excerpt-start={anchor ? '' : undefined} tabIndex={anchor ? -1 : undefined}>{content}</mark>;
}
function renderNode(node: RichContent, context: Context, state: RenderState, key: string): ReactNode {
  if (state.remaining-- <= 0 || state.structuralDepth >= 60) { state.exhausted = true; return null; }
  if (node.type === 'text' || node.type === 'statusBadge') {
    const text = node.text || '';
    const excerpt = state.excerpt?.marks.get(key);
    const wholeNodeSelected = excerpt?.kind === 'badge' || (excerpt?.kind === 'text' && excerpt.from === 0 && excerpt.to === text.length);
    let result: ReactNode = node.type === 'statusBadge' ? <ReadonlyStatusBadge attrs={node.attrs || {}} /> : text;
    if (excerpt?.kind === 'text' && !wholeNodeSelected) {
      const { from, to } = excerpt;
      result = <>{text.slice(0, from)}{excerptMark(text.slice(from, to), state, key)}{text.slice(to)}</>;
    }
    for (const mark of node.marks || []) {
      if (mark.type === 'bold') result = <strong>{result}</strong>;
      else if (mark.type === 'italic') result = <em>{result}</em>;
      else if (mark.type === 'strike') result = <s>{result}</s>;
      else if (mark.type === 'underline') result = <u>{result}</u>;
      else if (mark.type === 'code') result = <code>{result}</code>;
      else if (mark.type === 'link' && state.mode !== 'preview') {
        const fileId = attachmentDownloadIdFromUrl(mark.attrs?.href);
        const download = state.pinnedSource && fileId ? revisionAttachmentUrl(state.pinnedSource, 'files', fileId) : undefined;
        const href = download ?? safeUrl(mark.attrs?.href);
        if (href) result = <a href={href} download={download ? true : undefined} target={download ? undefined : '_blank'}
          rel="noopener noreferrer" onClick={event => event.stopPropagation()}>{result}</a>;
      }
    }
    if (wholeNodeSelected) result = excerptMark(result, state, key);
    return <span key={key}>{result}</span>;
  }
  if (node.type === 'documentRevisionInclude' && (!state.mode || state.mode === 'history')) {
    return pinnedRevision(textAttr(node, 'documentId'), textAttr(node, 'revisionId'), textAttr(node, 'label'), Math.min(state.remaining, context.includeBudget), key);
  }
  if (state.mode && (isLiveDocumentInclude(node.type) ||
      ['issueReference', 'documentReference', 'documentRevisionInclude', 'issueList', 'issueSummary', 'documentLabelList', 'documentChildList', 'documentPropertyReport'].includes(node.type))) {
    if (node.type === 'documentPropertyReport') {
      return <p className="doc-pinned-reference" key={key}>{documentPlainText(node)} · 이 저장본에는 보고서 조건이 보관됩니다.</p>;
    }
    return <p className="doc-pinned-reference" key={key}>{documentPlainText(node)}</p>;
  }
  if (node.type === 'issueReference') {
    const id = textAttr(node, 'issueId');
    return issueCard(context, id, textAttr(node, 'label'), key, state.includeDepth === 0 && id === state.referenceIssueId);
  }
  if (node.type === 'documentReference') return documentCard(context, textAttr(node, 'documentId'), textAttr(node, 'label'), false, key);
  if (isLiveDocumentInclude(node.type)) return renderIncluded(context, textAttr(node, 'documentId'), textAttr(node, 'label'), state, key, {
    excerpt: node.type === 'documentExcerptInclude', noPanel: node.attrs?.noPanel === true,
  });
  if (node.type === 'documentExcerpt' && node.attrs?.hidden === true && !state.mode) return null;
  if (node.type === 'documentToc') return <ReadonlyDocumentToc key={key} entries={state.outline} attrs={node.attrs} />;
  if (node.type === 'documentChildList') {
    const options = normalizeDocumentChildListOptions(node.attrs);
    if (!options) return <Notice key={key}>저장된 하위 문서 목록 설정을 확인할 수 없습니다.</Notice>;
    const projection = projectDocumentChildren(context.data.documents, state.documentId, options, context.data.documentOrders);
    const limit = Math.max(0, Math.min(state.remaining, projection.items.length));
    if (limit < projection.items.length) state.exhausted = true;
    state.remaining -= limit;
    return <DocumentChildListCard key={key} attrs={node.attrs} data={context.data} documentId={state.documentId}
      openDocument={context.openDocument} projection={projection} renderLimit={limit} />;
  }
  if (node.type === 'documentLabelList') {
    const options = normalizeDocumentLabelListOptions(node.attrs);
    if (!options) return <Notice key={key}>저장된 문서 목록 조건을 확인할 수 없습니다.</Notice>;
    const limit = Math.min(state.remaining, options.limit);
    if (limit < options.limit) state.exhausted = true;
    if (limit <= 0) return null;
    state.remaining -= limit;
    return <DocumentLabelListCard key={key} attrs={node.attrs} data={context.data} documentId={state.documentId}
      openDocument={context.openDocument} renderLimit={limit} />;
  }
  if (node.type === 'documentProperties') return <DocumentPropertiesCard key={key} attrs={node.attrs} />;
  if (node.type === 'documentPropertyReport') {
    const options = normalizeDocumentPropertyReportOptions(node.attrs);
    if (!options) return <Notice key={key}>저장된 속성 보고서 설정을 확인할 수 없습니다.</Notice>;
    const available = documentPropertyReportProjectIds(options).every(id => id === null || context.data.projects.some(project => project.id === id));
    const projection = available ? collectDocumentPropertyReport(context.data.documents, options) : undefined;
    const rowCount = projection?.rows.length ?? 0;
    const limit = Math.min(state.remaining, rowCount);
    if (limit < rowCount) state.exhausted = true;
    state.remaining -= limit;
    return <DocumentPropertyReportCard key={key} attrs={node.attrs} data={context.data} documentId={state.documentId}
      openDocument={context.openDocument} projection={projection} renderLimit={limit} />;
  }
  if (node.type === 'issueList' || node.type === 'issueSummary') {
    const limit = Math.min(state.remaining, DOCUMENT_ISSUE_LIST_LIMIT);
    if (limit < DOCUMENT_ISSUE_LIST_LIMIT) state.exhausted = true;
    if (limit <= 0) return null;
    state.remaining -= limit;
    const props = { data: context.data, openIssue: context.openIssue, limit };
    return node.type === 'issueSummary'
      ? <IssueSummaryCard key={key} {...props} attrs={issueSummaryAttrs(node.attrs)} />
      : <IssueListCard key={key} {...props} attrs={issueListAttrs(node.attrs)} />;
  }
  const nested = { ...state, structuralDepth: state.structuralDepth + 1 };
  const children = (node.content || []).map((child, index) => renderNode(child, context, nested, `${key}:${index}`));
  state.remaining = nested.remaining; state.exhausted = nested.exhausted;
  const attrs = node.attrs || {};
  switch (node.type) {
    case 'doc': return <div key={key}>{children}</div>;
    case 'paragraph': return <p key={key}>{children.length ? children : <br />}</p>;
    case 'heading': {
      const level = isDocumentHeadingLevel(attrs.level) ? attrs.level : 3;
      const Heading = `h${level}` as const;
      const canNavigate = children.every(child => child !== null);
      const title = canNavigate ? headingTitle(node) : '';
      const sectionId = state.includeDepth === 0 && isDocumentSectionId(attrs.sectionId) ? attrs.sectionId : undefined;
      if (state.section && sectionId === state.section.id) state.section.target = key;
      if (title) state.outline.push({ target: key, level, title, sectionId });
      return <Heading key={key} data-document-outline-target={title || sectionId ? key : undefined}
        data-document-section-id={sectionId} tabIndex={title || sectionId ? -1 : undefined}>{children}</Heading>;
    }
    case 'bulletList': return <ul key={key}>{children}</ul>;
    case 'orderedList': return <ol key={key} start={typeof attrs.start === 'number' ? attrs.start : undefined}>{children}</ol>;
    case 'listItem': return <li key={key}>{children}</li>;
    case 'taskList': return <ul key={key} className="doc-readonly-tasks">{children}</ul>;
    case 'taskItem': return <li key={key} className="doc-readonly-task"><input type="checkbox" checked={attrs.checked === true} disabled readOnly aria-label={attrs.checked ? '완료된 할 일' : '미완료 할 일'} /><div>{children}</div></li>;
    case 'blockquote': return <blockquote key={key}>{children}</blockquote>;
    case 'callout': return <ReadonlyCallout key={key} attrs={attrs}>{children}</ReadonlyCallout>;
    case 'documentColumnLayout': {
      const layout = normalizeDocumentColumnLayoutOptions(attrs, children.length);
      if (!layout) return <div key={key}>{children}</div>;
      return <div key={key} className="document-column-layout-readonly" role="group" aria-label="문서 다단 구역"
        data-teamspace-node="documentColumnLayout" data-layout-weights={layout.weights.join(',')} data-layout-border={String(layout.border)}>
        <div data-layout-grid="" style={{ '--document-column-tracks': documentColumnLayoutTracks(layout.weights) } as CSSProperties}>{children}</div>
      </div>;
    }
    case 'documentColumn': return <div key={key} data-teamspace-node="documentColumn">{children}</div>;
    case 'documentExcerpt': return state.mode
      ? <aside key={key} className="document-excerpt-definition" aria-label="저장된 발췌 구역">
        <div className="document-excerpt-heading"><strong>발췌 구역{attrs.hidden === true ? ' · 원본 숨김' : ''}</strong></div>
        <div className="document-excerpt-body">{children}</div>
      </aside>
      : <div key={key}>{children}</div>;
    case 'codeBlock': return <pre key={key}><code>{children}</code></pre>;
    case 'hardBreak': return <br key={key} />;
    case 'horizontalRule': return <hr key={key} />;
    case 'image': {
      const alt = typeof attrs.alt === 'string' ? attrs.alt : '';
      if (state.mode === 'preview') return <Notice key={key}>{alt ? `이미지 · ${alt}` : '이미지'}</Notice>;
      // A pinned snapshot can read its own archived attachment images.
      const src = imageUrl(attrs.src, state.pinnedSource);
      // eslint-disable-next-line @next/next/no-img-element
      return src ? <img key={key} src={src} alt={alt} title={typeof attrs.title === 'string' ? attrs.title : undefined} loading="lazy" /> : <Notice key={key}>이 이미지를 안전하게 표시할 수 없습니다.</Notice>;
    }
    case 'table': return <div key={key} className="doc-readonly-table"><table><tbody>{children}</tbody></table></div>;
    case 'tableRow': return <tr key={key}>{children}</tr>;
    case 'tableHeader': case 'tableCell': {
      const Cell = node.type === 'tableHeader' ? 'th' : 'td';
      const span = (value: unknown) => typeof value === 'number' ? Math.min(MAX_DOCUMENT_TABLE_SPAN, Math.max(1, value)) : undefined;
      return <Cell key={key} colSpan={span(attrs.colspan)} rowSpan={span(attrs.rowspan)}>{children}</Cell>;
    }
    case 'details': return <details key={key} className="doc-readonly-details" open>{children}</details>;
    case 'detailsSummary': return <summary key={key}>{children}</summary>;
    case 'detailsContent': return <div key={key} className="doc-details-content">{children}</div>;
    default: return <div key={key}><Notice>지원하지 않는 블록: {node.type}</Notice>{children}</div>;
  }
}
export function ReadonlyDocumentContent({ content, documentId, nodeBudget = TOTAL_INCLUDE_NODES, mode, pinnedSource, showOutline = false, sectionId, sectionLinkHref, referenceIssueId, selectionHighlight, canRevealExcerpt }: {
  content: RichContent;
  documentId?: string;
  nodeBudget?: number;
  mode?: RenderState['mode'];
  pinnedSource?: PinnedSource;
  showOutline?: boolean;
  sectionId?: string | null;
  sectionLinkHref?: (sectionId: string) => string;
  referenceIssueId?: string;
  selectionHighlight?: DocumentSelectionHighlight | null;
  canRevealExcerpt?: () => boolean;
}) {
  const context = contextOf(useContext(BlockContext));
  const contentRoot = useRef<HTMLDivElement>(null);
  const lastSection = useRef<{ documentId?: string; sectionId: string } | null>(null);
  const outline: DocumentOutlineEntry[] = [];
  const sourceDocumentId = documentId ?? context.documentId;
  const excerpt = mode === 'pinned' ? selectionHighlight : undefined;
  const state: RenderState = { documentId: sourceDocumentId, remaining: nodeBudget, exhausted: false, visited: new Set(sourceDocumentId ? [sourceDocumentId] : []), includeDepth: 0, structuralDepth: 0, mode, pinnedSource, outline, section: sectionId ? { id: sectionId } : undefined, referenceIssueId, excerpt: excerpt ? { ...excerpt, anchorRendered: false } : undefined };
  const body = renderNode(content, context, state, 'readonly');
  const sectionTarget = state.section?.target;
  const excerptTarget = state.excerpt?.anchorRendered ? state.excerpt.anchor : undefined;
  const goToHeading = useCallback((target: string) => {
    const root = contentRoot.current;
    if (!root) return false;
    return jumpToReadonlyHeading(root, target);
  }, []);
  useEffect(() => {
    if (lastSection.current && (lastSection.current.documentId !== documentId || lastSection.current.sectionId !== sectionId)) lastSection.current = null;
    if (!sectionId || !sectionTarget || lastSection.current) return;
    const frame = requestAnimationFrame(() => {
      if (goToHeading(sectionTarget)) lastSection.current = { documentId, sectionId };
    });
    return () => cancelAnimationFrame(frame);
  }, [documentId, sectionId, sectionTarget, goToHeading]);
  const goToExcerpt = useCallback(() => {
    const root = contentRoot.current;
    const target = root?.querySelector<HTMLElement>('[data-document-excerpt-start]');
    if (root && target?.closest('[data-document-outline-root]') === root) revealDocumentTarget(target, root, true);
  }, []);
  useEffect(() => {
    if (!excerptTarget || !canRevealExcerpt) return;
    const frame = requestAnimationFrame(() => { if (canRevealExcerpt()) goToExcerpt(); });
    return () => cancelAnimationFrame(frame);
  }, [excerptTarget, canRevealExcerpt, goToExcerpt]);
  return <>
    {sectionId && !sectionTarget && <p className="document-section-not-found" role="status">이 문서에서 연결된 절을 찾을 수 없습니다.</p>}
    {excerptTarget && <button type="button" className="btn btn-ghost doc-excerpt-jump" onClick={goToExcerpt}>발췌 위치로 이동</button>}
    {excerpt !== undefined && !excerptTarget && <p className="doc-pinned-message" role="status">저장본에서 발췌 위치를 찾을 수 없습니다.</p>}
    {showOutline && <DocumentOutline entries={outline} onNavigate={goToHeading} sectionLinkHref={sectionLinkHref} />}
    <div className="doc-readonly-content" data-document-outline-root="" data-static-document-content={mode ? '' : undefined} ref={contentRoot}>{body}{state.exhausted && <Notice>내용이 많거나 구조가 깊어 표시 한도에 도달했습니다. 원본 문서에서 이어서 확인하세요.</Notice>}</div>
  </>;
}
function ReferenceNodeView({ node, selected, deleteNode, updateAttributes, editor }: NodeViewProps) {
  const context = contextOf(useContext(BlockContext));
  const label = typeof node.attrs.label === 'string' ? node.attrs.label : '';
  const included = isLiveDocumentInclude(node.type.name);
  const excerpt = node.type.name === 'documentExcerptInclude';
  const pinned = node.type.name === 'documentRevisionInclude';
  const noPanel = excerpt && node.attrs.noPanel === true;
  const blockLabel = pinned ? '문서 버전 포함' : excerpt ? '발췌 포함' : included ? '문서 포함' : '참조';
  const state: RenderState = { documentId: context.documentId, remaining: context.includeBudget, exhausted: false, visited: new Set(context.documentId ? [context.documentId] : []), includeDepth: 0, structuralDepth: 0, outline: [] };
  return <NodeViewWrapper className={`doc-reference-node ${selected ? 'is-selected' : ''}`} contentEditable={false} data-teamspace-node={node.type.name} data-reference-id={node.attrs.issueId || node.attrs.documentId}>
    {node.type.name === 'issueReference' ? issueCard(context, node.attrs.issueId, label) : pinned
      ? pinnedRevision(node.attrs.documentId, node.attrs.revisionId, label, context.includeBudget, 'pin') : included
        ? renderIncluded(context, node.attrs.documentId, label, state, 'include', { excerpt, noPanel })
        : documentCard(context, node.attrs.documentId, label)}
    {excerpt && editor.isEditable && <label className="document-excerpt-panel-toggle">
      <input type="checkbox" checked={noPanel} onChange={event => {
        if (editor.isEditable) updateAttributes({ noPanel: event.target.checked });
      }} /> 원본 안내 숨기기
    </label>}
    {editor.isEditable && <button className="doc-reference-remove" type="button" aria-label={`${blockLabel} 블록 삭제`} onMouseDown={event => { event.preventDefault(); event.stopPropagation(); }} onClick={event => { event.stopPropagation(); if (editor.isEditable) deleteNode(); }}><X size={12} /></button>}
  </NodeViewWrapper>;
}
function DocumentExcerptNodeView({ node, selected, editor, getPos, updateAttributes }: NodeViewProps) {
  function unwrapExcerpt() {
    if (!editor.isEditable) return;
    const position = getPos();
    if (typeof position !== 'number') return;
    const { state, view } = editor;
    const current = state.doc.nodeAt(position);
    if (current?.type.name !== 'documentExcerpt') return;
    const tr = state.tr.replaceWith(position, position + current.nodeSize, current.content);
    tr.setSelection(TextSelection.near(tr.doc.resolve(position)));
    view.dispatch(tr);
    view.focus();
  }

  return <NodeViewWrapper as="section" className={`document-excerpt-definition${selected ? ' is-selected' : ''}`}
    data-teamspace-node="documentExcerpt" aria-label="발췌 구역">
    <div className="document-excerpt-heading" contentEditable={false}>
      <strong>발췌 구역</strong>
      {editor.isEditable && <>
        <label><input type="checkbox" checked={node.attrs.hidden === true}
          onChange={event => { if (editor.isEditable) updateAttributes({ hidden: event.target.checked }); }} /> 원본에서 숨기기</label>
        <button className="btn btn-ghost" type="button" onClick={unwrapExcerpt}>발췌 구역 해제</button>
      </>}
    </div>
    <NodeViewContent className="document-excerpt-body" />
  </NodeViewWrapper>;
}
function IssueBlockNodeView({ node, selected, getPos, deleteNode, editor }: NodeViewProps) {
  const context = contextOf(useContext(BlockContext));
  const nodeType = node.type.name === 'issueSummary' ? 'issueSummary' : 'issueList';
  const summaryAttrs = nodeType === 'issueSummary' ? issueSummaryAttrs(node.attrs) : null;
  const attrs = summaryAttrs ?? issueListAttrs(node.attrs);
  const canEdit = editor.isEditable && Boolean(context.openIssueBlock);
  const props = {
    data: context.data,
    openIssue: context.openIssue,
    onEdit: canEdit ? () => { if (editor.isEditable) context.openIssueBlock?.(editor, nodeType, { getPos, attrs }); } : undefined,
    onDelete: canEdit ? () => { if (editor.isEditable) deleteNode(); } : undefined,
  };
  return <NodeViewWrapper className={`doc-reference-node ${selected ? 'is-selected' : ''}`} contentEditable={false} data-teamspace-node={nodeType}>
    {summaryAttrs ? <IssueSummaryCard {...props} attrs={summaryAttrs} /> : <IssueListCard {...props} attrs={attrs} />}
  </NodeViewWrapper>;
}
function DocumentLabelListNodeView({ node, selected, editor, updateAttributes, deleteNode }: NodeViewProps) {
  const { data, documentId, openDocument, onListDraftChange } = contextOf(useContext(BlockContext));
  const id = useId();
  const trackSettingsDraft = useCallback((dirty: boolean) => onListDraftChange?.(id, dirty), [id, onListDraftChange]);
  return <NodeViewWrapper className={`doc-reference-node${selected ? ' is-selected' : ''}`} contentEditable={false} data-teamspace-node="documentLabelList">
    <DocumentLabelListCard attrs={node.attrs} data={data} documentId={documentId} openDocument={openDocument} onSettingsDraftChange={trackSettingsDraft}
      onChange={editor.isEditable ? attrs => { if (editor.isEditable) updateAttributes(attrs); } : undefined}
      onDelete={editor.isEditable ? () => { if (editor.isEditable) deleteNode(); } : undefined} />
  </NodeViewWrapper>;
}
function DocumentChildListNodeView({ node, selected, editor, getPos, updateAttributes, deleteNode }: NodeViewProps) {
  const { data, documentId, openDocument, onListDraftChange, editorReadOnly } = contextOf(useContext(BlockContext));
  const id = useId();
  const trackSettingsDraft = useCallback((dirty: boolean) => onListDraftChange?.(id, dirty), [id, onListDraftChange]);
  return <NodeViewWrapper className={`doc-reference-node${selected ? ' is-selected' : ''}`} contentEditable={false} data-teamspace-node="documentChildList">
    <DocumentChildListCard attrs={node.attrs} data={data} documentId={documentId} openDocument={openDocument} onSettingsDraftChange={trackSettingsDraft}
      onChange={!editorReadOnly ? (attrs, baseline) => {
        const position = getPos();
        const current = typeof position === 'number' ? editor.state.doc.nodeAt(position) : null;
        if (!editor.isEditable || current?.type.name !== 'documentChildList' ||
            JSON.stringify(normalizeDocumentChildListOptions(current.attrs)) !== JSON.stringify(baseline)) return false;
        updateAttributes(attrs);
        return true;
      } : undefined}
      onDelete={!editorReadOnly ? () => { if (editor.isEditable) deleteNode(); } : undefined} />
  </NodeViewWrapper>;
}
function DocumentPropertyNodeView({ node, selected, editor, getPos, updateAttributes, deleteNode }: NodeViewProps) {
  const { data, documentId, openDocument, onListDraftChange, editorReadOnly } = contextOf(useContext(BlockContext));
  const id = useId();
  const type = node.type.name;
  const trackSettingsDraft = useCallback((dirty: boolean) => onListDraftChange?.(id, dirty), [id, onListDraftChange]);

  function apply<Options extends object>(options: Options, baseline: Options | null, normalize: (attrs: unknown) => Options | null) {
    const position = getPos();
    const current = typeof position === 'number' ? editor.state.doc.nodeAt(position) : null;
    if (!editor.isEditable || current?.type.name !== type || JSON.stringify(normalize(current.attrs)) !== JSON.stringify(baseline)) return false;
    updateAttributes({ ...options });
    return true;
  }

  const actions = {
    onDelete: !editorReadOnly ? () => { if (editor.isEditable) deleteNode(); } : undefined,
    onSettingsDraftChange: trackSettingsDraft,
  };
  return <NodeViewWrapper className={`doc-reference-node${selected ? ' is-selected' : ''}`} contentEditable={false} data-teamspace-node={type}>
    {type === 'documentProperties' ? <DocumentPropertiesCard attrs={node.attrs} {...actions}
      onChange={!editorReadOnly ? (options, baseline) => apply(options, baseline, normalizeDocumentPropertiesOptions) : undefined} />
      : <DocumentPropertyReportCard attrs={node.attrs} {...actions} data={data} documentId={documentId} openDocument={openDocument}
        onChange={!editorReadOnly ? (options, baseline) => apply<typeof options>(
          { ...options, projectIds: options.projectIds ?? null }, baseline, normalizeDocumentPropertyReportOptions) : undefined} />}
  </NodeViewWrapper>;
}
function detailsBody(editor: Editor): boolean {
  const { $from, empty } = editor.state.selection;
  if (!empty || $from.parent.type.name !== 'detailsSummary') return false;
  for (let depth = $from.depth - 1; depth > 0; depth--) if ($from.node(depth).type.name === 'details') {
    const position = $from.before(depth) + 1 + $from.node(depth).child(0).nodeSize + 1;
    const dom = editor.view.nodeDOM($from.before(depth)); if (dom instanceof HTMLDetailsElement) dom.open = true;
    editor.view.focus();
    return editor.commands.command(({ tr }) => { tr.setSelection(TextSelection.near(tr.doc.resolve(position))); return true; });
  }
  return false;
}
export function decorateDocumentExtensions(extensions: AnyExtension[]): AnyExtension[] {
  return extensions.map(extension => extension.name === 'documentColumnLayout' ? extension.extend({
    addKeyboardShortcuts() { return { 'Mod-Shift-Enter': () => exitDocumentColumnLayout(this.editor) }; },
    addProseMirrorPlugins() { return [documentColumnLayoutEditingPlugin()]; },
  }) : extension.name === 'documentToc' ? extension.extend({ addNodeView() {
    return ReactNodeViewRenderer(DocumentTocNodeView);
  } }) : extension.name === 'documentChildList' ? extension.extend({ addNodeView() {
    return ReactNodeViewRenderer(DocumentChildListNodeView);
  } }) : extension.name === 'documentLabelList' ? extension.extend({ addNodeView() {
    return ReactNodeViewRenderer(DocumentLabelListNodeView);
  } }) : (extension.name === 'documentProperties' || extension.name === 'documentPropertyReport') ? extension.extend({ addNodeView() {
    return ReactNodeViewRenderer(DocumentPropertyNodeView);
  } }) : extension.name === 'documentExcerpt' ? extension.extend({ addNodeView() {
    return ReactNodeViewRenderer(DocumentExcerptNodeView);
  } }) : (extension.name === 'issueList' || extension.name === 'issueSummary') ? extension.extend({ addNodeView() { return ReactNodeViewRenderer(IssueBlockNodeView); } }) : (isLiveDocumentInclude(extension.name) || ['issueReference', 'documentReference', 'documentRevisionInclude'].includes(extension.name)) ? extension.extend({ addNodeView() { return ReactNodeViewRenderer(ReferenceNodeView); } }) : extension.name === 'details' ? extension.extend({
    addNodeView(): NodeViewRenderer { return ({ node }) => { const dom = document.createElement('details'); dom.open = true; dom.className = 'doc-details-block'; dom.dataset.teamspaceNode = 'details'; return { dom, contentDOM: dom, update: updated => updated.type === node.type, ignoreMutation: mutation => mutation.type === 'attributes' && mutation.target === dom && mutation.attributeName === 'open' }; }; },
    addKeyboardShortcuts() { return { Enter: () => detailsBody(this.editor), ArrowDown: () => this.editor.state.selection.$from.parentOffset === this.editor.state.selection.$from.parent.content.size && detailsBody(this.editor) }; },
  }) : decorateDocumentAnnotation(extension));
}
export function insertDetails(editor: Editor | null) { return editor?.chain().focus().insertContent({ type: 'details', content: [{ type: 'detailsSummary', content: [{ type: 'text', text: '내용 더 보기' }] }, { type: 'detailsContent', content: [{ type: 'paragraph' }] }] }).run(); }
export function insertDocumentExcerpt(editor: Editor) {
  if (!editor.isEditable) return false;
  if (!editor.state.selection.empty) return editor.chain().focus().wrapIn('documentExcerpt', { hidden: false }).run();
  return editor.chain().focus().insertContent([
    { type: 'documentExcerpt', attrs: { hidden: false }, content: [{ type: 'paragraph' }] },
    { type: 'paragraph' },
  ]).command(({ tr }) => {
    tr.doc.descendants((node, position) => {
      if (node.type.name !== 'documentExcerpt') return;
      tr.setSelection(TextSelection.near(tr.doc.resolve(position + 2)));
      return false;
    });
    return true;
  }).run();
}
export function unfoldDetails(editor: Editor | null) { if (!editor) return; for (const element of editor.view.dom.querySelectorAll<HTMLDetailsElement>('details[data-teamspace-node="details"]')) element.open = true; }
export function unwrapDetails(editor: Editor | null) {
  if (!editor) return false;
  return editor.commands.command(({ state, tr, dispatch }) => {
    for (let depth = state.selection.$from.depth; depth > 0; depth--) {
      const node = state.selection.$from.node(depth); if (node.type.name !== 'details') continue;
      const position = state.selection.$from.before(depth), summary = state.schema.nodes.paragraph.create(null, node.child(0).content), body = node.child(1).content;
      if (dispatch) { tr.replaceWith(position, position + node.nodeSize, Fragment.fromArray([summary, ...Array.from({ length: body.childCount }, (_, index) => body.child(index))])); tr.setSelection(TextSelection.near(tr.doc.resolve(position + 1))); dispatch(tr); }
      return true;
    }
    return false;
  });
}
function createsIncludeCycle(data: WorkspaceSnapshot, source: string, target: string) {
  const pending = [target], visited = new Set<string>();
  while (pending.length) { const id = pending.pop()!; if (id === source) return true; if (visited.has(id)) continue; visited.add(id); const page = data.documents.find(item => item.id === id); if (page) for (const ref of contentReferences(page.content)) if (ref.kind === 'include' && !ref.revisionId) pending.push(ref.id); }
  return false;
}

type RevisionChoice = Pick<DocRevision, 'id' | 'version' | 'title' | 'createdAt' | 'confluenceSourceVersion'>;
type RevisionPage = { items: RevisionChoice[]; nextOffset: number | null };
type RevisionPageLoad = { offset: number; attempt: number; page?: RevisionPage; error?: string };

function RevisionChoices({ source, onBack, onChoose }: { source: DocPage; onBack: () => void; onChoose: (revision: RevisionChoice) => void }) {
  const [offsets, setOffsets] = useState([0]);
  const [attempt, setAttempt] = useState(0);
  const [received, setReceived] = useState<RevisionPageLoad | null>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const offset = offsets[offsets.length - 1];
  const current = received?.offset === offset && received.attempt === attempt ? received : null;
  const next = current?.page?.nextOffset;

  useEffect(() => { backButton.current?.focus(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    api<RevisionPage>(`${includeRevisionPath(source.id)}?offset=${offset}`, { signal: controller.signal }).then(page => {
      if (!controller.signal.aborted) setReceived({ offset, attempt, page });
    }, error => {
      if (!controller.signal.aborted) setReceived({ offset, attempt, error: error instanceof Error ? error.message : '저장 버전을 불러오지 못했습니다.' });
    });
    return () => controller.abort();
  }, [source.id, offset, attempt]);

  return <>
    <div className="doc-revision-chooser-source">
      <button type="button" className="btn btn-ghost" ref={backButton} onClick={onBack}><ArrowLeft size={14} /> 문서 고르기</button>
      <strong>{source.title}</strong>
    </div>
    <div className="doc-reference-results doc-revision-options" aria-label="포함할 저장 버전" aria-busy={!current}>
      {!current && <p role="status">저장 버전을 불러오는 중…</p>}
      {current?.error && <><p role="alert">{current.error}</p><button type="button" onClick={() => setAttempt(previous => previous + 1)}>저장 버전 다시 불러오기</button></>}
      {current?.page?.items.map(revision => <button type="button" key={revision.id} aria-label={`${documentRevisionLabel(revision)} 포함`} onClick={() => onChoose(revision)}>
        <span>{documentRevisionLabel(revision)}</span><strong>{revision.title}</strong><time dateTime={revision.createdAt}>{new Date(revision.createdAt).toLocaleDateString('ko-KR')}</time><ChevronRight size={15} aria-hidden="true" />
      </button>)}
      {current?.page && !current.page.items.length && <p>포함할 저장 버전이 없습니다.</p>}
    </div>
    {(offsets.length > 1 || typeof next === 'number') && <div className="doc-revision-chooser-pages">
      <button type="button" className="btn btn-ghost" disabled={offsets.length === 1 || !current} onClick={() => setOffsets(previous => previous.slice(0, -1))}>이전 버전 목록</button>
      <button type="button" className="btn btn-ghost" disabled={typeof next !== 'number'} onClick={() => { if (typeof next === 'number') setOffsets(previous => [...previous, next]); }}>다음 버전 목록</button>
    </div>}
  </>;
}

export function ReferenceChooser({ selection, onClose, notify }: { selection: ReferenceSelection; onClose: () => void; notify: (message: string, kind?: 'success' | 'error') => void }) {
  const context = contextOf(useContext(BlockContext)), [query, setQuery] = useState('');
  const [source, setSource] = useState<DocPage | null>(null);
  const [noPanel, setNoPanel] = useState(false);
  const [slashError, setSlashError] = useState('');
  const { editor, slash } = selection;
  const bookmark = useRef(selection.bookmark);
  const resolveSlashRange = useDocumentSlashRange(editor, slash);
  const cancel = useCallback(() => {
    onClose();
    if (slash) restoreDocumentSlashFocus(editor);
  }, [editor, onClose, slash]);

  useLayoutEffect(() => {
    if (slash) return;
    bookmark.current = selection.bookmark;
    const map = ({ transaction }: { transaction: Transaction }) => { bookmark.current = bookmark.current.map(transaction.mapping); };
    editor.on('transaction', map);
    return () => { editor.off('transaction', map); };
  }, [editor, selection.bookmark, slash]);
  const issueMode = selection.kind === 'issueReference', includeMode = selection.kind === 'documentInclude', pinnedMode = selection.kind === 'documentRevisionInclude';
  const excerptMode = selection.kind === 'documentExcerptInclude';
  const dialogLabel = excerptMode ? '문서 발췌 포함' : issueMode ? '업무 참조 삽입' : includeMode ? '문서 포함 삽입' : pinnedMode ? '문서 버전 포함 삽입' : '문서 참조 삽입';
  const heading = excerptMode ? '발췌할 문서를 고르세요' : issueMode ? '업무를 참조하세요' : includeMode ? '문서 내용을 포함하세요' : pinnedMode ? '포함할 문서 버전을 고르세요' : '문서를 참조하세요';
  const description = includeMode || excerptMode ? '원본을 읽기 전용으로 표시합니다. 변경된 내용은 참조 새로고침으로 불러오세요.' : pinnedMode ? '문서를 고른 뒤 그 문서의 저장 버전을 선택하세요.' : '이름이 바뀌어도 같은 항목을 가리킵니다.';
  const { data } = context;
  const projects = new Map(data.projects.map(project => [project.id, project]));
  const search = query.toLowerCase();
  const issues = issueMode ? searchIssueCandidates(data, data.issues, query, issue => {
    const project = projects.get(issue.projectId);
    return `${issueSearchText(data, issue)} ${project?.key ?? ''} ${project?.name ?? ''}`;
  }).slice(0, 40) : [];
  const pages = issueMode ? [] : data.documents.filter(page => `${page.title} ${page.plainText}`.toLowerCase().includes(search) &&
    (!excerptMode || Boolean(findDocumentExcerpt(page.content)))).slice(0, 40);
  function insert(id: string, label: string, revisionId?: string) {
    if (!editor.isEditable || editor.isDestroyed || context.documentId !== selection.documentId) { notify('현재 편집할 문서를 다시 확인해주세요.', 'error'); return; }
    try {
      const attrs = { [issueMode ? 'issueId' : 'documentId']: id, label, ...(revisionId ? { revisionId } : {}), ...(excerptMode ? { noPanel } : {}) };
      const content: JSONContent[] = [{ type: selection.kind, attrs }, { type: 'paragraph' }];
      let success: boolean;
      if (slash) {
        const range = resolveSlashRange();
        if (!range) {
          setSlashError('슬래시 명령이 변경되었습니다. 편집 위치를 다시 선택해 주세요.');
          return;
        }
        success = insertDocumentSlashBlocks(editor, range, content);
      } else {
        const resolved = bookmark.current.resolve(editor.state.doc);
        success = editor.chain().focus().command(({ tr }) => { tr.setSelection(resolved); return true; }).insertContent(content).run();
      }
      if (!success) throw new Error('이 위치에는 참조 블록을 넣을 수 없습니다.');
      onClose();
    } catch (cause) { notify(cause instanceof Error ? cause.message : '블록을 삽입하지 못했습니다.', 'error'); }
  }
  return <div className="doc-reference-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) cancel(); }}>
    <section className="doc-reference-chooser" role="dialog" aria-modal="true" aria-label={dialogLabel} onKeyDown={event => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); }
    }}>
      <header><div><h3>{heading}</h3><p>{description}</p></div><button type="button" className="btn btn-ghost" aria-label="참조 삽입 닫기" onClick={cancel}><X size={16} /></button></header>
      {slashError && <p role="alert">{slashError}</p>}
      {source ? <RevisionChoices key={source.id} source={source} onBack={() => setSource(null)} onChoose={revision => insert(source.id, revision.title, revision.id)} /> : <>
        <label><Search size={15} /><input className="field" aria-label="참조할 항목 검색" placeholder={issueMode ? '업무 키(이전 키 포함), 제목, 속성 검색' : '문서 제목 또는 내용 검색'} autoFocus value={query} onChange={event => setQuery(event.target.value)} /></label>
        {excerptMode && <label className="document-excerpt-panel-toggle"><input type="checkbox" checked={noPanel}
          onChange={event => setNoPanel(event.target.checked)} /> 원본 안내 숨기기</label>}
        <div className="doc-reference-results">
          {issues.map(({ issue, matchedAliases }) => {
            const project = projects.get(issue.projectId);
            return <button type="button" key={issue.id} className="doc-reference-issue"
              onClick={() => insert(issue.id, `${issue.key} ${issue.title}`)}>
              <span>
                <small>{issue.key}{project && ` · ${project.name}`}</small>
                <strong>{issue.title}</strong>
                {matchedAliases.length > 0 && <small>{matchedAliases.map(issueSearchAliasLabel).join(' · ')}</small>}
              </span>
              <ChevronRight size={15} aria-hidden="true" />
            </button>;
          })}
          {pages.map(page => {
            const cycle = (includeMode || excerptMode) && createsIncludeCycle(data, selection.documentId, page.id);
            return <button type="button" key={page.id} disabled={cycle} title={cycle ? '자기 자신 또는 순환하는 문서는 포함할 수 없습니다.' : undefined}
              onClick={() => { if (pinnedMode) setSource(page); else insert(page.id, page.title); }}>
              <span>{projects.get(page.projectId ?? '')?.name || '팀 공통 문서'}</span><strong>{page.title}</strong>{cycle ? <small>순환 포함 불가</small> : <ChevronRight size={15} />}
            </button>;
          })}
          {!(issueMode ? issues : pages).length && <p>{excerptMode ? '조건에 맞는 발췌 문서가 없습니다.' : '조건에 맞는 항목이 없습니다.'}</p>}
        </div>
      </>}
    </section>
  </div>;
}
