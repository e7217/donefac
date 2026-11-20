import { Node, mergeAttributes } from '@tiptap/core';
import { documentNodes } from './document-references.js';
import type { ContentReference, RichContent } from './types.js';

export const DOCUMENT_ISSUE_LIST_LIMIT = 20;
export const MAX_DOCUMENT_ISSUE_BLOCKS = 30;
export const MAX_DOCUMENT_ISSUE_LISTS = MAX_DOCUMENT_ISSUE_BLOCKS;
export const DOCUMENT_CONTENT_SCHEMA_VERSION = 8;
export type DocumentTocLevel = 1 | 2 | 3;
export type DocumentTocLayout = 'list' | 'flat';
export interface DocumentTocOptions {
  minLevel: DocumentTocLevel;
  maxLevel: DocumentTocLevel;
  layout: DocumentTocLayout;
}
export const DOCUMENT_TOC_DEFAULTS = { minLevel: 1, maxLevel: 3, layout: 'list' } as const satisfies DocumentTocOptions;
export const ISSUE_SUMMARY_GROUP_BY = ['status', 'assignee', 'priority'] as const;
export type IssueSummaryGroupBy = typeof ISSUE_SUMMARY_GROUP_BY[number];
export const ISSUE_SUMMARY_GROUP_LABELS: Record<IssueSummaryGroupBy, string> = {
  status: '상태', assignee: '담당자', priority: '우선순위',
};
export const MAX_CALLOUT_TITLE_LENGTH = 300;
export const MAX_STATUS_BADGE_LABEL_LENGTH = 120;
export const CALLOUT_VARIANTS = ['info', 'note', 'warning', 'tip', 'panel'] as const;
export type CalloutVariant = typeof CALLOUT_VARIANTS[number];
export const CALLOUT_LABELS: Record<CalloutVariant, string> = {
  info: '정보', note: '참고', warning: '경고', tip: '팁', panel: '패널',
};
export const STATUS_BADGE_TONES = ['neutral', 'blue', 'green', 'amber', 'red', 'purple'] as const;
export type StatusBadgeTone = typeof STATUS_BADGE_TONES[number];
export const STATUS_BADGE_TONE_LABELS: Record<StatusBadgeTone, string> = {
  neutral: '기본', blue: '파랑', green: '초록', amber: '주황', red: '빨강', purple: '보라',
};
const versionTwoNodes = new Set(['issueReference', 'documentReference', 'documentInclude', 'details', 'detailsSummary', 'detailsContent']);
const referenceNodes = new Set(['issueReference', 'documentReference', 'documentInclude', 'documentRevisionInclude']);

type DocumentSchemaVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | typeof DOCUMENT_CONTENT_SCHEMA_VERSION;

export function documentNodeSchemaVersion(nodeType: string, attrs?: Record<string, unknown>): DocumentSchemaVersion {
  if (nodeType === 'documentToc') return 8;
  if (nodeType === 'heading' && attrs?.sectionId !== undefined) return 7;
  if (nodeType === 'callout' || nodeType === 'statusBadge') return 6;
  if (nodeType === 'documentRevisionInclude') return 5;
  if (nodeType === 'issueSummary') return 4;
  if (nodeType === 'issueList') return 3;
  return versionTwoNodes.has(nodeType) ? 2 : 1;
}

export function documentContentSchemaVersion(content: RichContent): DocumentSchemaVersion {
  let version: DocumentSchemaVersion = 1;
  for (const node of documentNodes(content)) {
    const minimum = documentNodeSchemaVersion(node.type, node.attrs);
    if (minimum === DOCUMENT_CONTENT_SCHEMA_VERSION) return minimum;
    if (minimum > version) version = minimum;
  }
  return version;
}

export function isDocumentTocLevel(value: unknown): value is DocumentTocLevel {
  return value === 1 || value === 2 || value === 3;
}

export function isDocumentTocLayout(value: unknown): value is DocumentTocLayout {
  return value === 'list' || value === 'flat';
}

export function documentTocOptions(attrs: Record<string, unknown> = {}): DocumentTocOptions {
  const minLevel = isDocumentTocLevel(attrs.minLevel) ? attrs.minLevel : DOCUMENT_TOC_DEFAULTS.minLevel;
  const maxLevel = isDocumentTocLevel(attrs.maxLevel) ? attrs.maxLevel : DOCUMENT_TOC_DEFAULTS.maxLevel;
  const range = minLevel <= maxLevel ? { minLevel, maxLevel } : DOCUMENT_TOC_DEFAULTS;
  return { ...range, layout: isDocumentTocLayout(attrs.layout) ? attrs.layout : DOCUMENT_TOC_DEFAULTS.layout };
}

export interface DocumentIssueList {
  projectId: string;
  savedViewId: string | null;
  label: string;
}

export interface DocumentIssueSummary extends DocumentIssueList { groupBy: IssueSummaryGroupBy }

export function isIssueSummaryGroupBy(value: unknown): value is IssueSummaryGroupBy {
  return ISSUE_SUMMARY_GROUP_BY.some(group => group === value);
}

export function isCalloutVariant(value: unknown): value is CalloutVariant {
  return CALLOUT_VARIANTS.some(variant => variant === value);
}

export function isStatusBadgeTone(value: unknown): value is StatusBadgeTone {
  return STATUS_BADGE_TONES.some(tone => tone === value);
}

export function isStatusBadgeLabel(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= MAX_STATUS_BADGE_LABEL_LENGTH;
}

export type DocumentIssueBlockTarget = {
  type: 'issueList' | 'issueSummary';
  projectId: string;
  savedViewId: string | null;
};

/** Dynamic query results do not form individual document references. */
export function documentIssueBlocks(content: RichContent): DocumentIssueBlockTarget[] {
  const blocks: DocumentIssueBlockTarget[] = [];
  for (const node of documentNodes(content)) {
    if ((node.type !== 'issueList' && node.type !== 'issueSummary') || typeof node.attrs?.projectId !== 'string') continue;
    blocks.push({
      type: node.type,
      projectId: node.attrs.projectId,
      savedViewId: typeof node.attrs.savedViewId === 'string' ? node.attrs.savedViewId : null,
    });
  }
  return blocks;
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
export const DocumentRevisionInclude = referenceNode('documentRevisionInclude', 'documentId', '문서 버전 포함').extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      revisionId: {
        default: '',
        parseHTML: element => element.getAttribute('data-revision-id') || '',
        renderHTML: attributes => ({ 'data-revision-id': attributes.revisionId }),
      },
    };
  },
});
function issueBlockNode(name: 'issueList' | 'issueSummary', label: string) {
  return Node.create({
    name, group: 'block', atom: true, selectable: true, draggable: true,
    addAttributes() { return {
      projectId: { default: '', parseHTML: element => element.getAttribute('data-project-id') || '', renderHTML: attributes => ({ 'data-project-id': attributes.projectId }) },
      savedViewId: { default: null, parseHTML: element => element.getAttribute('data-saved-view-id') || null, renderHTML: attributes => typeof attributes.savedViewId === 'string' ? { 'data-saved-view-id': attributes.savedViewId } : {} },
      label: { default: '', parseHTML: element => element.getAttribute('data-label') || '', renderHTML: attributes => ({ 'data-label': attributes.label }) },
      ...(name === 'issueSummary' ? { groupBy: {
        default: 'status',
        parseHTML: (element: HTMLElement) => element.getAttribute('data-group-by') ?? 'status',
        renderHTML: (attributes: Record<string, unknown>) => ({ 'data-group-by': attributes.groupBy }),
      } } : {}),
    }; },
    parseHTML() { return [{ tag: `div[data-teamspace-node="${name}"]` }]; },
    renderHTML({ node, HTMLAttributes }) {
      return ['div', mergeAttributes(HTMLAttributes, { 'data-teamspace-node': name }), String(node.attrs.label || label)];
    },
  });
}
export const IssueList = issueBlockNode('issueList', '업무 목록');
export const IssueSummary = issueBlockNode('issueSummary', '업무 현황');

function tocLevelAttribute(key: 'minLevel' | 'maxLevel', attribute: string) {
  return {
    default: DOCUMENT_TOC_DEFAULTS[key],
    parseHTML: (element: HTMLElement) => {
      const level = Number(element.getAttribute(attribute));
      return isDocumentTocLevel(level) ? level : DOCUMENT_TOC_DEFAULTS[key];
    },
    renderHTML: (attributes: Record<string, unknown>) => ({ [attribute]: attributes[key] }),
  };
}

const tocMinLevel = tocLevelAttribute('minLevel', 'data-toc-min-level');
const tocMaxLevel = tocLevelAttribute('maxLevel', 'data-toc-max-level');
export const DocumentToc = Node.create({
  name: 'documentToc', group: 'block', atom: true, selectable: true, draggable: true,
  addAttributes() {
    return {
      minLevel: tocMinLevel,
      maxLevel: tocMaxLevel,
      layout: {
        default: DOCUMENT_TOC_DEFAULTS.layout,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-toc-layout') === 'flat' ? 'flat' : 'list',
        renderHTML: (attributes: Record<string, unknown>) => ({ 'data-toc-layout': attributes.layout }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'nav[data-teamspace-node="documentToc"]',
      getAttrs: element => tocMinLevel.parseHTML(element) <= tocMaxLevel.parseHTML(element) ? null : false }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['nav', mergeAttributes(HTMLAttributes, { 'data-teamspace-node': 'documentToc' }), '본문 목차'];
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

const calloutContent = ':scope > div[data-teamspace-callout-content]';
export const Callout = Node.create({
  name: 'callout', group: 'block', content: 'block+', defining: true, isolating: true,
  addAttributes() {
    return {
      variant: {
        default: 'info',
        parseHTML: element => {
          const value = element.getAttribute('data-callout-variant');
          return isCalloutVariant(value) ? value : 'info';
        },
        renderHTML: attributes => ({ 'data-callout-variant': isCalloutVariant(attributes.variant) ? attributes.variant : 'info' }),
      },
      title: {
        default: '',
        parseHTML: element => {
          const value = element.getAttribute('data-callout-title') ?? '';
          return value.length <= MAX_CALLOUT_TITLE_LENGTH ? value : '';
        },
        renderHTML: attributes => ({ 'data-callout-title': attributes.title }),
      },
    };
  },
  parseHTML() {
    return [{
      tag: 'aside[data-teamspace-node="callout"]',
      getAttrs: element => element.querySelector(calloutContent) ? null : false,
      contentElement: calloutContent,
    }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const variant = isCalloutVariant(node.attrs.variant) ? node.attrs.variant : 'info';
    const title = typeof node.attrs.title === 'string' ? node.attrs.title : '';
    return ['aside', mergeAttributes(HTMLAttributes, { 'data-teamspace-node': 'callout', class: 'document-callout' }),
      ['div', { class: 'document-callout-header', contenteditable: 'false' }, title || CALLOUT_LABELS[variant]],
      ['div', { class: 'document-callout-content', 'data-teamspace-callout-content': '' }, 0],
    ];
  },
});

const statusBadgeLabel = (element: HTMLElement) => element.getAttribute('data-status-label') ?? element.textContent;
export const StatusBadge = Node.create({
  name: 'statusBadge', group: 'inline', inline: true, atom: true, selectable: true,
  addAttributes() {
    return {
      label: {
        default: '',
        parseHTML: statusBadgeLabel,
        renderHTML: attributes => ({ 'data-status-label': attributes.label }),
      },
      tone: {
        default: 'neutral',
        parseHTML: element => {
          const value = element.getAttribute('data-status-tone');
          return isStatusBadgeTone(value) ? value : 'neutral';
        },
        renderHTML: attributes => ({ 'data-status-tone': isStatusBadgeTone(attributes.tone) ? attributes.tone : 'neutral' }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-teamspace-node="statusBadge"]', getAttrs: element => isStatusBadgeLabel(statusBadgeLabel(element)) ? null : false }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-teamspace-node': 'statusBadge', class: 'document-status-badge' }), String(node.attrs.label)];
  },
  renderText({ node }) { return String(node.attrs.label); },
});

export function documentNodeExtensions() {
  return [IssueReference, DocumentReference, DocumentInclude, DocumentRevisionInclude, IssueList, IssueSummary, Details, DetailsSummary, DetailsContent, Callout, StatusBadge, DocumentToc];
}

export function documentRevisionIncludes(content: RichContent): { documentId: string; revisionId: string }[] {
  const revisions: { documentId: string; revisionId: string }[] = [];
  for (const node of documentNodes(content)) {
    if (node.type !== 'documentRevisionInclude') continue;
    const { documentId, revisionId } = node.attrs || {};
    if (typeof documentId === 'string' && documentId && typeof revisionId === 'string' && revisionId) {
      revisions.push({ documentId, revisionId });
    }
  }
  return revisions;
}

/** Stored references only; included documents are deliberately not expanded. */
export function contentReferences(content: RichContent): ContentReference[] {
  const references: ContentReference[] = [];
  for (const node of documentNodes(content)) {
    if (!referenceNodes.has(node.type)) continue;
    const type = node.type === 'issueReference' ? 'issue' : 'document';
    const id = node.attrs?.[type === 'issue' ? 'issueId' : 'documentId'];
    if (typeof id !== 'string' || !id) continue;
    const pinned = node.type === 'documentRevisionInclude';
    const revisionId = pinned && typeof node.attrs?.revisionId === 'string' ? node.attrs.revisionId : undefined;
    references.push({ type, id, kind: pinned || node.type === 'documentInclude' ? 'include' : 'reference',
      label: typeof node.attrs?.label === 'string' ? node.attrs.label : '', ...(revisionId ? { revisionId } : {}) });
  }
  return references;
}

export function documentPlainText(node: RichContent): string {
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'statusBadge') return typeof node.attrs?.label === 'string' ? node.attrs.label : '';
  if (referenceNodes.has(node.type)) {
    const id = String(node.attrs?.[node.type === 'issueReference' ? 'issueId' : 'documentId'] || '');
    const label = String(node.attrs?.label || id);
    if (node.type === 'documentRevisionInclude') return `[문서 버전 포함: ${label} (${id} @ ${String(node.attrs?.revisionId || '')})]`;
    return `[${node.type === 'issueReference' ? '업무' : node.type === 'documentInclude' ? '문서 포함' : '문서'}: ${label} (${id})]`;
  }
  if (node.type === 'issueList' || node.type === 'issueSummary') {
    const project = String(node.attrs?.projectId || '');
    const view = node.attrs?.savedViewId ? ` / ${String(node.attrs.savedViewId)}` : '';
    const group = isIssueSummaryGroupBy(node.attrs?.groupBy) ? node.attrs.groupBy : 'status';
    const kind = node.type === 'issueSummary' ? `업무 현황 · ${ISSUE_SUMMARY_GROUP_LABELS[group]}별` : '업무 목록';
    return `[${kind}: ${String(node.attrs?.label || project)} (${project}${view})]`;
  }
  if (node.type === 'image') return String(node.attrs?.alt || '');
  const separator = node.type === 'tableRow' ? '\t' : ['paragraph', 'heading', 'codeBlock', 'detailsSummary'].includes(node.type) ? '' : '\n';
  const text = (node.content || []).map(documentPlainText).join(separator);
  if (node.type === 'callout' && typeof node.attrs?.title === 'string' && node.attrs.title) {
    return text ? `${node.attrs.title}\n${text}` : node.attrs.title;
  }
  return text;
}
