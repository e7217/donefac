import { Node, mergeAttributes } from '@tiptap/core';
import type { ContentReference, RichContent } from './types.js';

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
export function documentNodeExtensions() { return [IssueReference, DocumentReference, DocumentInclude, Details, DetailsSummary, DetailsContent]; }

/** Stored references only; included documents are deliberately not expanded. */
export function contentReferences(content: RichContent): ContentReference[] {
  const references: ContentReference[] = [], pending = [content];
  while (pending.length) {
    const node = pending.pop()!;
    if (['issueReference', 'documentReference', 'documentInclude'].includes(node.type)) {
      const type = node.type === 'issueReference' ? 'issue' : 'document';
      const id = node.attrs?.[type === 'issue' ? 'issueId' : 'documentId'];
      if (typeof id === 'string' && id) references.push({ type, id, kind: node.type === 'documentInclude' ? 'include' : 'reference', label: typeof node.attrs?.label === 'string' ? node.attrs.label : '' });
    }
    for (let index = (node.content?.length || 0) - 1; index >= 0; index--) pending.push(node.content![index]);
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
  if (node.type === 'image') return String(node.attrs?.alt || '');
  const separator = node.type === 'tableRow' ? '\t' : ['paragraph', 'heading', 'codeBlock', 'detailsSummary'].includes(node.type) ? '' : '\n';
  return (node.content || []).map(documentPlainText).join(separator);
}
