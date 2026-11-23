import { documentChildListDescription, normalizeDocumentChildListOptions } from './document-child-list.js';
import { documentLabelListDescription, normalizeDocumentLabelListOptions } from './document-label-list.js';
import { documentPropertyReportDescription, normalizeDocumentPropertiesOptions, normalizeDocumentPropertyReportOptions } from './document-properties.js';
import { isDocumentReferenceNode } from './document-references.js';
import type { RichContent } from './types.js';

export const ISSUE_SUMMARY_GROUP_BY = ['status', 'assignee', 'priority'] as const;
export type IssueSummaryGroupBy = typeof ISSUE_SUMMARY_GROUP_BY[number];
export const ISSUE_SUMMARY_GROUP_LABELS: Record<IssueSummaryGroupBy, string> = {
  status: '상태', assignee: '담당자', priority: '우선순위',
};

export function isIssueSummaryGroupBy(value: unknown): value is IssueSummaryGroupBy {
  return ISSUE_SUMMARY_GROUP_BY.some(group => group === value);
}

export function documentPlainText(node: RichContent): string {
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'statusBadge') return typeof node.attrs?.label === 'string' ? node.attrs.label : '';
  if (node.type === 'documentLabelList') {
    const options = normalizeDocumentLabelListOptions(node.attrs);
    return options ? `[라벨별 문서 · ${documentLabelListDescription(options)}]` : '[라벨별 문서]';
  }
  if (node.type === 'documentChildList') {
    const options = normalizeDocumentChildListOptions(node.attrs);
    return options ? `[하위 문서 목록 · ${documentChildListDescription(options)}]` : '[하위 문서 목록]';
  }
  if (node.type === 'documentProperties') {
    const options = normalizeDocumentPropertiesOptions(node.attrs);
    if (!options || options.hidden) return '';
    return [options.group, ...options.entries.map(({ name, value }) => `${name}\t${value}`)].filter(Boolean).join('\n');
  }
  if (node.type === 'documentPropertyReport') {
    const options = normalizeDocumentPropertyReportOptions(node.attrs);
    return options ? `[문서 속성 보고서 · ${documentPropertyReportDescription(options)}]` : '[문서 속성 보고서]';
  }
  if (isDocumentReferenceNode(node.type)) {
    const id = String(node.attrs?.[node.type === 'issueReference' ? 'issueId' : 'documentId'] || '');
    const label = String(node.attrs?.label || id);
    if (node.type === 'documentRevisionInclude') return `[문서 버전 포함: ${label} (${id} @ ${String(node.attrs?.revisionId || '')})]`;
    if (node.type === 'documentExcerptInclude') return `[문서 발췌 포함: ${label} (${id})]`;
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
