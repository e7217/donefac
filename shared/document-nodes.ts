import { Node, mergeAttributes } from '@tiptap/core';
import { DOCUMENT_CHILD_LIST_DEFAULTS, normalizeDocumentChildListOptions } from './document-child-list.js';
import { DOCUMENT_LABEL_LIST_DEFAULTS, normalizeDocumentLabelListOptions } from './document-label-list.js';
import {
  DOCUMENT_PROPERTIES_DEFAULTS, DOCUMENT_PROPERTY_REPORT_DEFAULTS, normalizeDocumentPropertiesOptions, normalizeDocumentPropertyReportOptions,
} from './document-properties.js';
import { documentNodes, isDocumentReferenceNode } from './document-references.js';
import type { IssueSummaryGroupBy } from './document-plain-text.js';
import type { ContentReference, RichContent } from './types.js';

export { documentPlainText, ISSUE_SUMMARY_GROUP_BY, ISSUE_SUMMARY_GROUP_LABELS, isIssueSummaryGroupBy, type IssueSummaryGroupBy } from './document-plain-text.js';

export const DOCUMENT_ISSUE_LIST_LIMIT = 20;
export const MAX_DOCUMENT_ISSUE_BLOCKS = 30;
export const MAX_DOCUMENT_ISSUE_LISTS = MAX_DOCUMENT_ISSUE_BLOCKS;
export const DOCUMENT_CONTENT_SCHEMA_VERSION = 17;
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
export const MAX_DOCUMENT_NODES = 30_000;
export const MAX_DOCUMENT_COLUMNS = 3;
export const MAX_DOCUMENT_TABLE_SPAN = 100;

export interface DocumentColumnLayoutOptions {
  weights: number[];
  border: boolean;
}

export function normalizeDocumentColumnLayoutOptions(attrs: unknown, columnCount: number): DocumentColumnLayoutOptions | null {
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs) ||
      Object.keys(attrs).some(key => key !== 'weights' && key !== 'border')) return null;
  const { weights, border = false } = attrs as Record<string, unknown>;
  if (!Array.isArray(weights) || weights.length < 1 || weights.length > MAX_DOCUMENT_COLUMNS || weights.length !== columnCount ||
      typeof border !== 'boolean') return null;
  const tracks = Array.from(weights);
  if (!tracks.every(weight => Number.isInteger(weight) && weight >= 1 && weight <= 1000)) return null;
  return { weights: tracks, border };
}

export function documentColumnLayoutTracks(weights: readonly number[]): string {
  return weights.map(weight => `minmax(0, ${weight}fr)`).join(' ');
}
export const DOCUMENT_HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;
export type DocumentHeadingLevel = (typeof DOCUMENT_HEADING_LEVELS)[number];
export function isDocumentHeadingLevel(value: unknown): value is DocumentHeadingLevel {
  return DOCUMENT_HEADING_LEVELS.some(level => level === value);
}

export type DocumentTocLevel = DocumentHeadingLevel;
export type DocumentTocLayout = 'list' | 'flat';
export interface DocumentTocOptions {
  minLevel: DocumentTocLevel;
  maxLevel: DocumentTocLevel;
  layout: DocumentTocLayout;
}
export const DOCUMENT_TOC_DEFAULTS = { minLevel: 1, maxLevel: 3, layout: 'list' } as const satisfies DocumentTocOptions;
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

type DocumentSchemaVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | typeof DOCUMENT_CONTENT_SCHEMA_VERSION;
const isDeepHeadingLevel = (level: unknown) => isDocumentHeadingLevel(level) && level > 3;

export function documentNodeSchemaVersion(nodeType: string, attrs?: Record<string, unknown>): DocumentSchemaVersion {
  if (nodeType === 'documentPropertyReport' && Array.isArray(attrs?.projectIds)) return 17;
  if ((nodeType === 'heading' && isDeepHeadingLevel(attrs?.level)) || (nodeType === 'documentToc' &&
      (isDeepHeadingLevel(attrs?.minLevel) || isDeepHeadingLevel(attrs?.maxLevel)))) return 16;
  if (nodeType === 'taskItem' && attrs?.checklistItemId !== undefined) return 15;
  if (nodeType === 'documentChildList' && attrs?.sort === 'manual') return 14;
  if (nodeType === 'documentProperties' || nodeType === 'documentPropertyReport') return 13;
  if (nodeType === 'documentColumnLayout' || nodeType === 'documentColumn') return 12;
  if (nodeType === 'documentExcerpt' || nodeType === 'documentExcerptInclude') return 11;
  if (nodeType === 'documentChildList') return 10;
  if (nodeType === 'documentLabelList') return 9;
  if (nodeType === 'documentToc') return 8;
  if (nodeType === 'heading' && attrs?.sectionId !== undefined) return 7;
  if (nodeType === 'callout' || nodeType === 'statusBadge') return 6;
  if (nodeType === 'documentRevisionInclude') return 5;
  if (nodeType === 'issueSummary') return 4;
  if (nodeType === 'issueList') return 3;
  return versionTwoNodes.has(nodeType) ? 2 : 1;
}

export function isLiveDocumentInclude(type: string): boolean {
  return type === 'documentInclude' || type === 'documentExcerptInclude';
}

export function findDocumentExcerpt(content: RichContent): RichContent | undefined {
  for (const node of documentNodes(content)) if (node.type === 'documentExcerpt') return node;
  return undefined;
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
  return isDocumentHeadingLevel(value);
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
    parseHTML() { return [{ tag: `div[data-donefac-node="${name}"]` }]; },
    renderHTML({ node, HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-donefac-node': name }), String(node.attrs.label || label)]; },
  });
}

export const IssueReference = referenceNode('issueReference', 'issueId', '업무 참조');
export const DocumentReference = referenceNode('documentReference', 'documentId', '문서 참조');
export const DocumentInclude = referenceNode('documentInclude', 'documentId', '문서 포함');
export const DocumentExcerptInclude = referenceNode('documentExcerptInclude', 'documentId', '문서 발췌 포함').extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      noPanel: {
        default: false,
        parseHTML: element => element.getAttribute('data-no-panel') === 'true',
        renderHTML: attributes => ({ 'data-no-panel': attributes.noPanel ? 'true' : 'false' }),
      },
    };
  },
});
export const DocumentExcerpt = Node.create({
  name: 'documentExcerpt',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      hidden: {
        default: false,
        parseHTML: element => element.getAttribute('data-excerpt-hidden') === 'true',
        renderHTML: attributes => ({ 'data-excerpt-hidden': attributes.hidden ? 'true' : 'false' }),
      },
    };
  },
  parseHTML() { return [{ tag: 'div[data-donefac-node="documentExcerpt"]' }]; },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-donefac-node': 'documentExcerpt' }), 0];
  },
});
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
    parseHTML() { return [{ tag: `div[data-donefac-node="${name}"]` }]; },
    renderHTML({ node, HTMLAttributes }) {
      return ['div', mergeAttributes(HTMLAttributes, { 'data-donefac-node': name }), String(node.attrs.label || label)];
    },
  });
}
export const IssueList = issueBlockNode('issueList', '업무 목록');
export const IssueSummary = issueBlockNode('issueSummary', '업무 현황');

function propertyBlockNode(name: 'documentProperties' | 'documentPropertyReport', label: string,
  defaults: object, normalize: (attributes: unknown) => object | null) {
  return Node.create({
    name, group: 'block', atom: true, selectable: true, draggable: true,
    addAttributes() {
      return Object.fromEntries(Object.entries(defaults).map(([key, value]) =>
        [key, { default: value, rendered: false, parseHTML: () => null }]));
    },
    parseHTML() {
      return [{
        tag: `div[data-donefac-node="${name}"][data-document-property-options]`,
        getAttrs: element => {
          try {
            const options = normalize(JSON.parse(element.getAttribute('data-document-property-options') ?? ''));
            return options ? { ...options } : false;
          } catch {
            return false;
          }
        },
      }];
    },
    renderHTML({ node }) {
      return ['div', {
        'data-donefac-node': name,
        'data-document-property-options': JSON.stringify(normalize(node.attrs) ?? defaults),
      }, label];
    },
  });
}

export const DocumentProperties = propertyBlockNode('documentProperties', '문서 속성',
  DOCUMENT_PROPERTIES_DEFAULTS, normalizeDocumentPropertiesOptions);
export const DocumentPropertyReport = propertyBlockNode('documentPropertyReport', '문서 속성 보고서',
  DOCUMENT_PROPERTY_REPORT_DEFAULTS, normalizeDocumentPropertyReportOptions);

export const DocumentLabelList = Node.create({
  name: 'documentLabelList', group: 'block', atom: true, selectable: true, draggable: true,
  addAttributes() {
    return Object.fromEntries(Object.entries(DOCUMENT_LABEL_LIST_DEFAULTS).map(([key, value]) =>
      [key, { default: value, rendered: false, parseHTML: () => null }]));
  },
  parseHTML() {
    return [{
      tag: 'div[data-donefac-node="documentLabelList"][data-document-label-list]',
      getAttrs: element => {
        try {
          return normalizeDocumentLabelListOptions(JSON.parse(element.getAttribute('data-document-label-list') ?? '')) ?? false;
        } catch {
          return false;
        }
      },
    }];
  },
  renderHTML({ node }) {
    const options = normalizeDocumentLabelListOptions(node.attrs);
    return ['div', {
      'data-donefac-node': 'documentLabelList',
      'data-document-label-list': JSON.stringify(options ?? DOCUMENT_LABEL_LIST_DEFAULTS),
    }, '라벨별 문서'];
  },
});

export const DocumentChildList = Node.create({
  name: 'documentChildList', group: 'block', atom: true, selectable: true, draggable: true,
  addAttributes() {
    return Object.fromEntries(Object.entries(DOCUMENT_CHILD_LIST_DEFAULTS).map(([key, value]) =>
      [key, { default: value, rendered: false, parseHTML: () => null }]));
  },
  parseHTML() {
    return [{
      tag: 'div[data-donefac-node="documentChildList"][data-document-child-list]',
      getAttrs: element => {
        try {
          return normalizeDocumentChildListOptions(JSON.parse(element.getAttribute('data-document-child-list') ?? '')) ?? false;
        } catch {
          return false;
        }
      },
    }];
  },
  renderHTML({ node }) {
    const options = normalizeDocumentChildListOptions(node.attrs);
    return ['div', {
      'data-donefac-node': 'documentChildList',
      'data-document-child-list': JSON.stringify(options ?? DOCUMENT_CHILD_LIST_DEFAULTS),
    }, '하위 문서 목록'];
  },
});

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
    return [{ tag: 'nav[data-donefac-node="documentToc"]',
      getAttrs: element => tocMinLevel.parseHTML(element) <= tocMaxLevel.parseHTML(element) ? null : false }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['nav', mergeAttributes(HTMLAttributes, { 'data-donefac-node': 'documentToc' }), '본문 목차'];
  },
});

export const Details = Node.create({
  name: 'details', group: 'block', content: 'detailsSummary detailsContent', defining: true, isolating: true,
  parseHTML() { return [{ tag: 'details[data-donefac-node="details"]' }]; },
  // Open/closed is a local reading choice, absent from persisted attributes.
  renderHTML({ HTMLAttributes }) { return ['details', mergeAttributes(HTMLAttributes, { 'data-donefac-node': 'details', open: '' }), 0]; },
});
export const DetailsSummary = Node.create({
  name: 'detailsSummary', content: 'inline*', defining: true,
  parseHTML() { return [{ tag: 'summary' }]; }, renderHTML() { return ['summary', 0]; },
});
export const DetailsContent = Node.create({
  name: 'detailsContent', content: 'block+', defining: true,
  parseHTML() { return [{ tag: 'div[data-donefac-details-content]' }]; }, renderHTML() { return ['div', { 'data-donefac-details-content': '' }, 0]; },
});

const layoutGrid = ':scope > div[data-layout-grid]';
const columnElement = 'div[data-donefac-node="documentColumn"]';
export const DocumentColumnLayout = Node.create({
  name: 'documentColumnLayout', group: 'block', content: `documentColumn{1,${MAX_DOCUMENT_COLUMNS}}`, defining: true, isolating: true,
  addAttributes() {
    return {
      weights: { default: [1], rendered: false, parseHTML: () => null },
      border: { default: false, rendered: false, parseHTML: () => null },
    };
  },
  parseHTML() {
    return [{
      tag: 'div[data-donefac-node="documentColumnLayout"]',
      contentElement: layoutGrid,
      getAttrs: element => {
        const grid = element.querySelector(layoutGrid);
        const weights = element.getAttribute('data-layout-weights');
        const border = element.getAttribute('data-layout-border');
        if (!grid || Array.from(grid.children).some(child => !child.matches(columnElement)) ||
            !weights || !/^\d+(?:,\d+){0,2}$/u.test(weights) || (border !== null && border !== 'false' && border !== 'true')) return false;
        return normalizeDocumentColumnLayoutOptions({ weights: weights.split(',').map(Number), border: border === 'true' }, grid.childElementCount) ?? false;
      },
    }];
  },
  renderHTML({ node }) {
    const { weights, border } = normalizeDocumentColumnLayoutOptions(node.attrs, node.childCount) ??
      { weights: Array.from({ length: node.childCount }, () => 1), border: false };
    return ['div', { 'data-donefac-node': 'documentColumnLayout', 'data-layout-weights': weights.join(','), 'data-layout-border': String(border) },
      ['div', { 'data-layout-grid': '', style: `--document-column-tracks: ${documentColumnLayoutTracks(weights)}` }, 0]];
  },
});

export const DocumentColumn = Node.create({
  name: 'documentColumn', content: 'block+', defining: true, isolating: true, selectable: false,
  parseHTML() { return [{ tag: columnElement }]; },
  renderHTML() { return ['div', { 'data-donefac-node': 'documentColumn' }, 0]; },
});

const calloutContent = ':scope > div[data-donefac-callout-content]';
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
      tag: 'aside[data-donefac-node="callout"]',
      getAttrs: element => element.querySelector(calloutContent) ? null : false,
      contentElement: calloutContent,
    }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const variant = isCalloutVariant(node.attrs.variant) ? node.attrs.variant : 'info';
    const title = typeof node.attrs.title === 'string' ? node.attrs.title : '';
    return ['aside', mergeAttributes(HTMLAttributes, { 'data-donefac-node': 'callout', class: 'document-callout' }),
      ['div', { class: 'document-callout-header', contenteditable: 'false' }, title || CALLOUT_LABELS[variant]],
      ['div', { class: 'document-callout-content', 'data-donefac-callout-content': '' }, 0],
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
    return [{ tag: 'span[data-donefac-node="statusBadge"]', getAttrs: element => isStatusBadgeLabel(statusBadgeLabel(element)) ? null : false }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-donefac-node': 'statusBadge', class: 'document-status-badge' }), String(node.attrs.label)];
  },
  renderText({ node }) { return String(node.attrs.label); },
});

export function documentNodeExtensions() {
  return [
    IssueReference, DocumentReference, DocumentInclude, DocumentRevisionInclude, DocumentExcerpt, DocumentExcerptInclude,
    IssueList, IssueSummary, Details, DetailsSummary, DetailsContent, DocumentColumnLayout, DocumentColumn,
    Callout, StatusBadge, DocumentToc, DocumentLabelList, DocumentChildList, DocumentProperties, DocumentPropertyReport,
  ];
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
    if (node.type === 'documentChildList') {
      const options = normalizeDocumentChildListOptions(node.attrs);
      if (options?.scope === 'document' && options.documentId) {
        references.push({ type: 'document', id: options.documentId, kind: 'reference', label: options.title });
      }
      continue;
    }
    if (!isDocumentReferenceNode(node.type)) continue;
    const type = node.type === 'issueReference' ? 'issue' : 'document';
    const id = node.attrs?.[type === 'issue' ? 'issueId' : 'documentId'];
    if (typeof id !== 'string' || !id) continue;
    const pinned = node.type === 'documentRevisionInclude';
    const revisionId = pinned && typeof node.attrs?.revisionId === 'string' ? node.attrs.revisionId : undefined;
    references.push({ type, id, kind: pinned || isLiveDocumentInclude(node.type) ? 'include' : 'reference',
      label: typeof node.attrs?.label === 'string' ? node.attrs.label : '', ...(revisionId ? { revisionId } : {}) });
  }
  return references;
}
