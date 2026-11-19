'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NodeViewWrapper, ReactNodeViewRenderer, type Editor, type NodeViewProps } from '@tiptap/react';
import { Fragment } from '@tiptap/pm/model';
import { TextSelection, type SelectionBookmark, type Transaction } from '@tiptap/pm/state';
import type { AnyExtension, NodeViewRenderer } from '@tiptap/core';
import { ChevronRight, FileText, Link2, Search, X } from 'lucide-react';
import type { DocPage, RichContent, WorkspaceSnapshot } from '../../shared/types';
import { contentReferences, DOCUMENT_ISSUE_LIST_LIMIT } from '../../shared/document-nodes';
import { issueSearchText } from '../../shared/issue-schema';
import { statusMeta } from '../../shared/workflow-helpers';
import { IssueListCard, issueListAttrs, type OpenIssueBlock } from './DocumentIssueList';
import { IssueSummaryCard, issueSummaryAttrs } from './DocumentIssueSummary';
import './document-blocks.css';

export type ReferenceKind = 'issueReference' | 'documentReference' | 'documentInclude';
export type ReferenceSelection = { kind: ReferenceKind; editor: Editor; bookmark: SelectionBookmark; documentId: string };
const MAX_INCLUDE_DEPTH = 5, TOTAL_INCLUDE_NODES = 4000;
type Context = { data: WorkspaceSnapshot; documentId: string | null; openIssue: (id: string) => void; openDocument: (id: string) => void; openIssueBlock?: OpenIssueBlock; includeBudget: number };
const BlockContext = createContext<Context | null>(null);
export function DocumentBlocksProvider({ data, documentId, content, openIssue, openDocument, openIssueBlock, children }: { data: WorkspaceSnapshot; documentId: string | null; content?: RichContent; openIssue: Context['openIssue']; openDocument: Context['openDocument']; openIssueBlock?: OpenIssueBlock; children: ReactNode }) {
  const count = content ? contentReferences(content).filter(reference => reference.kind === 'include').length : 0;
  const value = useMemo(() => ({ data, documentId, openIssue, openDocument, openIssueBlock, includeBudget: Math.floor(TOTAL_INCLUDE_NODES / Math.max(1, count)) }), [data, documentId, openIssue, openDocument, openIssueBlock, count]);
  return <BlockContext.Provider value={value}>{children}</BlockContext.Provider>;
}
function contextOf(value: Context | null): Context { if (!value) throw new Error('문서 블록을 표시할 문맥이 없습니다.'); return value; }
function textAttr(node: RichContent, name: string) { return typeof node.attrs?.[name] === 'string' ? node.attrs[name] as string : ''; }
function issueCard(context: Context, id: string, label: string, key?: string) {
  const issue = context.data.issues.find(item => item.id === id), meta = issue ? statusMeta(context.data, issue.projectId, issue.status) : null;
  return <button key={key} type="button" className={`doc-reference-card issue ${issue ? '' : 'is-missing'}`} disabled={!issue} aria-label={issue ? `참조 업무 열기 ${issue.key} ${issue.title}` : `찾을 수 없는 업무 ${label || id}`} onMouseDown={event => { event.preventDefault(); event.stopPropagation(); }} onClick={event => { event.stopPropagation(); if (issue) context.openIssue(issue.id); }}><span className="doc-reference-icon"><Link2 size={15} /></span><span><small>{issue?.key || '찾을 수 없는 업무'}</small><strong>{issue?.title || label || id}</strong></span>{meta && <em style={{ color: meta.color }}><i style={{ background: meta.color }} />{meta.label}</em>}</button>;
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
type RenderState = { remaining: number; exhausted: boolean; visited: Set<string>; includeDepth: number; structuralDepth: number };
function renderIncluded(context: Context, id: string, label: string, state: RenderState, key: string): ReactNode {
  const document = context.data.documents.find(item => item.id === id);
  if (!document) return <Notice key={key}>포함 문서를 찾을 수 없습니다: {label || id}</Notice>;
  if (state.visited.has(id)) return <Notice key={key}>순환 문서 포함을 중단했습니다: {document.title}</Notice>;
  if (state.includeDepth >= MAX_INCLUDE_DEPTH) return <Notice key={key}>문서 포함 깊이 제한(5단계)에 도달했습니다: {document.title}</Notice>;
  const next = { ...state, visited: new Set([...state.visited, id]), includeDepth: state.includeDepth + 1 };
  const rendered = renderNode(document.content, context, next, `${key}:body`);
  state.remaining = next.remaining; state.exhausted = next.exhausted;
  return <section className="doc-included-content" key={key} aria-label={`포함된 문서 ${document.title}`}>{documentCard(context, id, label, true)}<div className="doc-readonly-content">{rendered}{state.includeDepth === 0 && state.exhausted && <Notice>포함된 내용이 많거나 구조가 깊어 표시 한도에 도달했습니다. 원본 문서에서 이어서 확인하세요.</Notice>}</div></section>;
}
function renderNode(node: RichContent, context: Context, state: RenderState, key: string): ReactNode {
  if (state.remaining-- <= 0 || state.structuralDepth >= 60) { state.exhausted = true; return null; }
  if (node.type === 'text') {
    let result: ReactNode = node.text || '';
    for (const mark of node.marks || []) {
      if (mark.type === 'bold') result = <strong>{result}</strong>;
      else if (mark.type === 'italic') result = <em>{result}</em>;
      else if (mark.type === 'strike') result = <s>{result}</s>;
      else if (mark.type === 'underline') result = <u>{result}</u>;
      else if (mark.type === 'code') result = <code>{result}</code>;
      else if (mark.type === 'link') { const href = safeUrl(mark.attrs?.href); result = href ? <a href={href} target="_blank" rel="noopener noreferrer" onClick={event => event.stopPropagation()}>{result}</a> : result; }
    }
    return <span key={key}>{result}</span>;
  }
  if (node.type === 'issueReference') return issueCard(context, textAttr(node, 'issueId'), textAttr(node, 'label'), key);
  if (node.type === 'documentReference') return documentCard(context, textAttr(node, 'documentId'), textAttr(node, 'label'), false, key);
  if (node.type === 'documentInclude') return renderIncluded(context, textAttr(node, 'documentId'), textAttr(node, 'label'), state, key);
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
    case 'heading': return attrs.level === 1 ? <h1 key={key}>{children}</h1> : attrs.level === 2 ? <h2 key={key}>{children}</h2> : <h3 key={key}>{children}</h3>;
    case 'bulletList': return <ul key={key}>{children}</ul>;
    case 'orderedList': return <ol key={key} start={typeof attrs.start === 'number' ? attrs.start : undefined}>{children}</ol>;
    case 'listItem': return <li key={key}>{children}</li>;
    case 'taskList': return <ul key={key} className="doc-readonly-tasks">{children}</ul>;
    case 'taskItem': return <li key={key} className="doc-readonly-task"><input type="checkbox" checked={attrs.checked === true} disabled readOnly aria-label={attrs.checked ? '완료된 할 일' : '미완료 할 일'} /><div>{children}</div></li>;
    case 'blockquote': return <blockquote key={key}>{children}</blockquote>;
    case 'codeBlock': return <pre key={key}><code>{children}</code></pre>;
    case 'hardBreak': return <br key={key} />;
    case 'horizontalRule': return <hr key={key} />;
    // Existing stored image URLs render directly; no resizing proxy is involved.
    // eslint-disable-next-line @next/next/no-img-element
    case 'image': { const src = safeUrl(attrs.src, true); return src ? <img key={key} src={src} alt={typeof attrs.alt === 'string' ? attrs.alt : ''} title={typeof attrs.title === 'string' ? attrs.title : undefined} loading="lazy" /> : <Notice key={key}>이 이미지를 안전하게 표시할 수 없습니다.</Notice>; }
    case 'table': return <div key={key} className="doc-readonly-table"><table><tbody>{children}</tbody></table></div>;
    case 'tableRow': return <tr key={key}>{children}</tr>;
    case 'tableHeader': return <th key={key} colSpan={typeof attrs.colspan === 'number' ? Math.min(100, Math.max(1, attrs.colspan)) : undefined} rowSpan={typeof attrs.rowspan === 'number' ? Math.min(100, Math.max(1, attrs.rowspan)) : undefined}>{children}</th>;
    case 'tableCell': return <td key={key} colSpan={typeof attrs.colspan === 'number' ? Math.min(100, Math.max(1, attrs.colspan)) : undefined} rowSpan={typeof attrs.rowspan === 'number' ? Math.min(100, Math.max(1, attrs.rowspan)) : undefined}>{children}</td>;
    case 'details': return <details key={key} className="doc-readonly-details" open>{children}</details>;
    case 'detailsSummary': return <summary key={key}>{children}</summary>;
    case 'detailsContent': return <div key={key} className="doc-details-content">{children}</div>;
    default: return <div key={key}><Notice>지원하지 않는 블록: {node.type}</Notice>{children}</div>;
  }
}
export function ReadonlyDocumentContent({ content, documentId, nodeBudget = TOTAL_INCLUDE_NODES }: { content: RichContent; documentId?: string; nodeBudget?: number }) {
  const context = contextOf(useContext(BlockContext));
  const state: RenderState = { remaining: nodeBudget, exhausted: false, visited: new Set(documentId ? [documentId] : context.documentId ? [context.documentId] : []), includeDepth: 0, structuralDepth: 0 };
  return <div className="doc-readonly-content">{renderNode(content, context, state, 'readonly')}{state.exhausted && <Notice>내용이 많거나 구조가 깊어 표시 한도에 도달했습니다. 원본 문서에서 이어서 확인하세요.</Notice>}</div>;
}
function ReferenceNodeView({ node, selected, deleteNode, editor }: NodeViewProps) {
  const context = contextOf(useContext(BlockContext));
  const label = typeof node.attrs.label === 'string' ? node.attrs.label : '';
  const included = node.type.name === 'documentInclude';
  const state: RenderState = { remaining: context.includeBudget, exhausted: false, visited: new Set(context.documentId ? [context.documentId] : []), includeDepth: 0, structuralDepth: 0 };
  return <NodeViewWrapper className={`doc-reference-node ${selected ? 'is-selected' : ''}`} contentEditable={false} data-teamspace-node={node.type.name} data-reference-id={node.attrs.issueId || node.attrs.documentId}>
    {node.type.name === 'issueReference' ? issueCard(context, node.attrs.issueId, label) : included ? renderIncluded(context, node.attrs.documentId, label, state, 'include') : documentCard(context, node.attrs.documentId, label)}
    {editor.isEditable && <button className="doc-reference-remove" type="button" aria-label={`${included ? '문서 포함' : '참조'} 블록 삭제`} onMouseDown={event => { event.preventDefault(); event.stopPropagation(); }} onClick={event => { event.stopPropagation(); if (editor.isEditable) deleteNode(); }}><X size={12} /></button>}
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
  return extensions.map(extension => (extension.name === 'issueList' || extension.name === 'issueSummary') ? extension.extend({ addNodeView() { return ReactNodeViewRenderer(IssueBlockNodeView); } }) : ['issueReference', 'documentReference', 'documentInclude'].includes(extension.name) ? extension.extend({ addNodeView() { return ReactNodeViewRenderer(ReferenceNodeView); } }) : extension.name === 'details' ? extension.extend({
    addNodeView(): NodeViewRenderer { return ({ node }) => { const dom = document.createElement('details'); dom.open = true; dom.className = 'doc-details-block'; dom.dataset.teamspaceNode = 'details'; return { dom, contentDOM: dom, update: updated => updated.type === node.type, ignoreMutation: mutation => mutation.type === 'attributes' && mutation.target === dom && mutation.attributeName === 'open' }; }; },
    addKeyboardShortcuts() { return { Enter: () => detailsBody(this.editor), ArrowDown: () => this.editor.state.selection.$from.parentOffset === this.editor.state.selection.$from.parent.content.size && detailsBody(this.editor) }; },
  }) : extension);
}
export function insertDetails(editor: Editor | null) { return editor?.chain().focus().insertContent({ type: 'details', content: [{ type: 'detailsSummary', content: [{ type: 'text', text: '내용 더 보기' }] }, { type: 'detailsContent', content: [{ type: 'paragraph' }] }] }).run(); }
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
  while (pending.length) { const id = pending.pop()!; if (id === source) return true; if (visited.has(id)) continue; visited.add(id); const page = data.documents.find(item => item.id === id); if (page) for (const ref of contentReferences(page.content)) if (ref.kind === 'include') pending.push(ref.id); }
  return false;
}
export function ReferenceChooser({ selection, onClose, notify }: { selection: ReferenceSelection; onClose: () => void; notify: (message: string, kind?: 'success' | 'error') => void }) {
  const context = contextOf(useContext(BlockContext)), [query, setQuery] = useState('');
  const bookmark = useRef(selection.bookmark);
  useEffect(() => {
    const map = ({ transaction }: { transaction: Transaction }) => { bookmark.current = bookmark.current.map(transaction.mapping); };
    selection.editor.on('transaction', map);
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', escape);
    return () => { selection.editor.off('transaction', map); window.removeEventListener('keydown', escape); };
  }, [selection.editor, onClose]);
  const issueMode = selection.kind === 'issueReference', includeMode = selection.kind === 'documentInclude';
  const results = issueMode ? context.data.issues.filter(issue => issueSearchText(context.data, issue).toLowerCase().includes(query.toLowerCase())).slice(0, 40) : context.data.documents.filter(page => `${page.title} ${page.plainText}`.toLowerCase().includes(query.toLowerCase())).slice(0, 40);
  function insert(id: string, label: string) {
    if (!selection.editor.isEditable || selection.editor.isDestroyed || context.documentId !== selection.documentId) { notify('현재 편집할 문서를 다시 확인해주세요.', 'error'); return; }
    try {
      const resolved = bookmark.current.resolve(selection.editor.state.doc);
      const success = selection.editor.chain().focus().command(({ tr }) => { tr.setSelection(resolved); return true; }).insertContent([{ type: selection.kind, attrs: { [issueMode ? 'issueId' : 'documentId']: id, label } }, { type: 'paragraph' }]).run();
      if (!success) throw new Error('이 위치에는 참조 블록을 넣을 수 없습니다.');
      onClose();
    } catch (cause) { notify(cause instanceof Error ? cause.message : '블록을 삽입하지 못했습니다.', 'error'); }
  }
  return <div className="doc-reference-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section className="doc-reference-chooser" role="dialog" aria-modal="true" aria-label={issueMode ? '업무 참조 삽입' : includeMode ? '문서 포함 삽입' : '문서 참조 삽입'}><header><div><h3>{issueMode ? '업무를 참조하세요' : includeMode ? '문서 내용을 포함하세요' : '문서를 참조하세요'}</h3><p>{includeMode ? '원본을 읽기 전용으로 표시합니다. 변경된 내용은 참조 새로고침으로 불러오세요.' : '이름이 바뀌어도 같은 항목을 가리킵니다.'}</p></div><button type="button" className="btn btn-ghost" aria-label="참조 삽입 닫기" onClick={onClose}><X size={16} /></button></header><label><Search size={15} /><input className="field" aria-label="참조할 항목 검색" placeholder={issueMode ? '업무 번호, 제목, 속성 검색' : '문서 제목 또는 내용 검색'} autoFocus value={query} onChange={event => setQuery(event.target.value)} /></label><div className="doc-reference-results">{results.map(item => { const issue = 'key' in item ? item : null, page = issue ? null : item as DocPage, cycle = !!page && includeMode && createsIncludeCycle(context.data, selection.documentId, page.id); return <button type="button" key={item.id} disabled={cycle} title={cycle ? '자기 자신 또는 순환하는 문서는 포함할 수 없습니다.' : undefined} onClick={() => insert(item.id, issue ? `${issue.key} ${issue.title}` : item.title)}><span>{issue?.key || context.data.projects.find(project => project.id === page?.projectId)?.name || '팀 공통 문서'}</span><strong>{item.title}</strong>{cycle ? <small>순환 포함 불가</small> : <ChevronRight size={15} />}</button>; })}{!results.length && <p>조건에 맞는 항목이 없습니다.</p>}</div></section></div>;
}
