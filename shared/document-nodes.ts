import { Node, mergeAttributes } from '@tiptap/core';
import type { ContentReference, RichContent } from './types.js';

export const DOCUMENT_ISSUE_LIST_LIMIT = 20;
export const MAX_DOCUMENT_ISSUE_LISTS = 30;
const versionTwoNodes = new Set(['issueReference', 'documentReference', 'documentInclude', 'details', 'detailsSummary', 'detailsContent']);

export function documentNodeSchemaVersion(nodeType: string): 1 | 2 | 3 {
  if (nodeType === 'issueList') return 3;
  return versionTwoNodes.has(nodeType) ? 2 : 1;
}

function* documentNodes(content: RichContent): Generator<RichContent> {
  const pending = [content];
  while (pending.length) {
    const node = pending.pop()!;
    yield node;
    for (let index = (node.content?.length || 0) - 1; index >= 0; index--) pending.push(node.content![index]);
  }
}

export function documentContentSchemaVersion(content: RichContent): 1 | 2 | 3 {
  let version: 1 | 2 = 1;
  for (const node of documentNodes(content)) {
    const minimum = documentNodeSchemaVersion(node.type);
    if (minimum === 3) return 3;
    if (minimum === 2) version = 2;
  }
  return version;
}

export interface DocumentIssueList {
  projectId: string;
  savedViewId: string | null;
  label: string;
}

/** Stored list selectors. Dynamic query results do not form individual document references. */
export function documentIssueLists(content: RichContent): DocumentIssueList[] {
  const lists: DocumentIssueList[] = [];
  for (const node of documentNodes(content)) {
    if (node.type !== 'issueList' || typeof node.attrs?.projectId !== 'string') continue;
    lists.push({
      projectId: node.attrs.projectId,
      savedViewId: typeof node.attrs.savedViewId === 'string' ? node.attrs.savedViewId : null,
      label: typeof node.attrs.label === 'string' ? node.attrs.label : '',
    });
  }
  return lists;
}

function referenceNode(name: string, idAttribute: string, label: string) {
  const dataId = idAttribute === 'issueId' ? 'data-issue-id' : 'data-document-id';
  return Node.create({
    name, group: 'block', atom: true, selectable: true, draggable: true,
    addAttributes() { return {
      [idAttribute]: { default: '', parseHTML: element => element.getAttribute(dataId) || '', renderHTML: attributes => ({ [dataId]: attributes[idAttribute] }) },
      label: { default: '', parseHTML: element => element.getAttribute('data-label') || '', renderHTML: attributes => ({ 'data-label': attributes.label }) },
    }; },
    parseHTML() { return [{ tag: `div[data-teamspace-node="${name}"]` }]; },
    renderHTML({ node, HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-teamspace-node': name }), String(node.attrs.label || label)]; },
  });
}

export const IssueReference = referenceNode('issueReference', 'issueId', '업무 참조');
export const DocumentReference = referenceNode('documentReference', 'documentId', '문서 참조');
export const DocumentInclude = referenceNode('documentInclude', 'documentId', '문서 포함');
export const IssueList = Node.create({
  name: 'issueList', group: 'block', atom: true, selectable: true, draggable: true,
  addAttributes() { return {
    projectId: { default: '', parseHTML: element => element.getAttribute('data-project-id') || '', renderHTML: attributes => ({ 'data-project-id': attributes.projectId }) },
    savedViewId: { default: null, parseHTML: element => element.getAttribute('data-saved-view-id') || null, renderHTML: attributes => typeof attributes.savedViewId === 'string' ? { 'data-saved-view-id': attributes.savedViewId } : {} },
    label: { default: '', parseHTML: element => element.getAttribute('data-label') || '', renderHTML: attributes => ({ 'data-label': attributes.label }) },
  }; },
  parseHTML() { return [{ tag: 'div[data-teamspace-node="issueList"]' }]; },
  renderHTML({ node, HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-teamspace-node': 'issueList' }), String(node.attrs.label || '업무 목록')];
  },
});
export const Details = Node.create({
  name: 'details', group: 'block', content: 'detailsSummary detailsContent', defining: true, isolating: true,
  parseHTML() { return [{ tag: 'details[data-teamspace-node="details"]' }]; },
  // Open/closed is a local reading choice, absent from persisted attributes.
  renderHTML({ HTMLAttributes }) { return ['details', mergeAttributes(HTMLAttributes, { 'data-teamspace-node': 'details', open: '' }), 0]; },
});
export const DetailsSummary = Node.create({
  name: 'detailsSummary', content: 'inline*', defining: true,
  parseHTML() { return [{ tag: 'summary' }]; }, renderHTML() { return ['summary', 0]; },
});
export const DetailsContent = Node.create({
  name: 'detailsContent', content: 'block+', defining: true,
  parseHTML() { return [{ tag: 'div[data-teamspace-details-content]' }]; }, renderHTML() { return ['div', { 'data-teamspace-details-content': '' }, 0]; },
});
export function documentNodeExtensions() { return [IssueReference, DocumentReference, DocumentInclude, IssueList, Details, DetailsSummary, DetailsContent]; }

/** Stored references only; included documents are deliberately not expanded. */
export function contentReferences(content: RichContent): ContentReference[] {
  const references: ContentReference[] = [];
  for (const node of documentNodes(content)) {
    if (['issueReference', 'documentReference', 'documentInclude'].includes(node.type)) {
      const type = node.type === 'issueReference' ? 'issue' : 'document';
      const id = node.attrs?.[type === 'issue' ? 'issueId' : 'documentId'];
      if (typeof id === 'string' && id) references.push({ type, id, kind: node.type === 'documentInclude' ? 'include' : 'reference', label: typeof node.attrs?.label === 'string' ? node.attrs.label : '' });
    }
  }
  return references;
}

export function documentPlainText(node: RichContent): string {
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  if (['issueReference', 'documentReference', 'documentInclude'].includes(node.type)) {
    const id = String(node.attrs?.[node.type === 'issueReference' ? 'issueId' : 'documentId'] || '');
    const label = String(node.attrs?.label || id);
    return `[${node.type === 'issueReference' ? '업무' : node.type === 'documentInclude' ? '문서 포함' : '문서'}: ${label} (${id})]`;
  }
  if (node.type === 'issueList') {
    const project = String(node.attrs?.projectId || '');
    const view = node.attrs?.savedViewId ? ` / ${String(node.attrs.savedViewId)}` : '';
    return `[업무 목록: ${String(node.attrs?.label || project)} (${project}${view})]`;
  }
  if (node.type === 'image') return String(node.attrs?.alt || '');
  const separator = node.type === 'tableRow' ? '\t' : ['paragraph', 'heading', 'codeBlock', 'detailsSummary'].includes(node.type) ? '' : '\n';
  return (node.content || []).map(documentPlainText).join(separator);
}
