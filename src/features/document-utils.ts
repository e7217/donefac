import type { DocRevision, RichContent } from '../../shared/types';
import { renderStandaloneDocumentTableMarkdown } from '../../shared/document-export-markdown';
import { CALLOUT_LABELS, ISSUE_SUMMARY_GROUP_LABELS, documentPlainText, documentTocOptions, isCalloutVariant, isIssueSummaryGroupBy, isStatusBadgeTone } from '../../shared/document-nodes';
import { documentNodes } from '../../shared/document-references';
import { isDocumentSectionId, outlineHeadingTitle } from '../../shared/document-sections';

export function contentText(node: RichContent): string { return documentPlainText(node); }

export function documentRevisionLabel(revision: Pick<DocRevision, 'version' | 'confluenceSourceVersion'>): string {
  return revision.confluenceSourceVersion == null ? `버전 ${revision.version}` : `Confluence 원본 버전 ${revision.confluenceSourceVersion}`;
}

export function hasDocumentFormattedBlocks(node: RichContent): boolean {
  return ['callout', 'statusBadge', 'documentExcerpt', 'documentExcerptInclude', 'documentColumnLayout'].includes(node.type) ||
    (node.content?.some(hasDocumentFormattedBlocks) ?? false);
}

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function statusBadgeHtml(node: RichContent) {
  const label = escapeHtml(String(node.attrs?.label ?? '')).replace(/\|/g, '&#124;');
  const tone = isStatusBadgeTone(node.attrs?.tone) ? node.attrs.tone : 'neutral';
  return `<span data-teamspace-node="statusBadge" data-status-tone="${tone}" data-status-label="${label}" class="document-status-badge">${label}</span>`;
}

function summaryHtml(node: RichContent): string {
  if (node.type === 'hardBreak') return '<br>';
  if (node.type !== 'text' && node.type !== 'statusBadge') return (node.content || []).map(summaryHtml).join('');
  let text = node.type === 'statusBadge' ? statusBadgeHtml(node) : escapeHtml(node.text || '');
  for (const mark of node.marks || []) {
    const tag = ({bold:'strong',italic:'em',strike:'s',code:'code',underline:'u'} as Record<string,string>)[mark.type];
    if (tag) text = `<${tag}>${text}</${tag}>`;
    if (mark.type === 'link' && /^(?:https?:\/\/|mailto:|#|\/)/i.test(String(mark.attrs?.href || ''))) text = `<a href="${escapeHtml(String(mark.attrs?.href))}">${text}</a>`;
  }
  return text;
}

type MarkdownHeading = { anchor: string; level: number; title: string };

function markdownHeadings(content: RichContent): Map<RichContent, MarkdownHeading> | undefined {
  const headings: RichContent[] = [];
  let hasToc = false;
  for (const node of documentNodes(content)) {
    if (node.type === 'documentToc') hasToc = true;
    if (node.type === 'heading') headings.push(node);
  }
  if (!hasToc) return;
  const reserved = new Set(headings.map(node => node.attrs?.sectionId).filter(isDocumentSectionId));
  const result = new Map<RichContent, MarkdownHeading>();
  let next = 0;
  for (const heading of headings) {
    const title = outlineHeadingTitle(documentPlainText(heading));
    if (!title) continue;
    const sectionId = heading.attrs?.sectionId;
    let anchor = isDocumentSectionId(sectionId) ? sectionId : '';
    if (!anchor) {
      do { anchor = `teamspace-toc-${++next}`; } while (reserved.has(anchor));
    }
    result.set(heading, { anchor, level: Number(heading.attrs?.level) || 1, title });
  }
  return result;
}

export function contentMarkdown(node: RichContent): string {
  return renderMarkdown(node, markdownHeadings(node));
}

function renderMarkdown(node: RichContent, headings?: Map<RichContent, MarkdownHeading>): string {
  const render = (node: RichContent) => renderMarkdown(node, headings);
  const inline = () => (node.content || []).map(render).join('');
  if (node.type === 'text') {
    let text = (node.text || '').replace(/([\\`*_[\]])/g, '\\$1');
    for (const mark of node.marks || []) {
      if (mark.type === 'bold') text = `**${text}**`;
      if (mark.type === 'italic') text = `*${text}*`;
      if (mark.type === 'strike') text = `~~${text}~~`;
      if (mark.type === 'code') text = '`' + (node.text || '').replace(/`/g, '\\`') + '`';
      if (mark.type === 'link') text = `[${text}](${String(mark.attrs?.href || '').replace(/[()]/g, encodeURIComponent)})`;
    }
    return text;
  }
  switch (node.type) {
    case 'doc': return inline().trim() + '\n';
    case 'paragraph': return inline() + '\n\n';
    case 'heading': {
      const sectionId = headings?.get(node)?.anchor ?? node.attrs?.sectionId;
      const anchor = isDocumentSectionId(sectionId) ? `<a id="${sectionId}"></a>\n\n` : '';
      return anchor + '#'.repeat(Math.min(6, Math.max(1, Number(node.attrs?.level) || 1))) + ' ' + inline() + '\n\n';
    }
    case 'hardBreak': return '  \n';
    case 'documentLabelList':
    case 'documentChildList':
      return `> ${documentPlainText(node).replace(/([\\`*_[\]<>])/g, '\\$1')}\n\n`;
    case 'documentToc': {
      const { minLevel, maxLevel, layout } = documentTocOptions(node.attrs);
      const links = [...(headings?.values() ?? [])].filter(entry => entry.level >= minLevel && entry.level <= maxLevel)
        .map(entry => `[${entry.title.replace(/([\\`*_\[\]<>])/g, '\\$1')}](#${entry.anchor})`);
      const items = layout === 'flat' ? links.join(' · ') : links.map(link => `- ${link}`).join('\n');
      return `**본문 목차**\n\n${items || '선택한 단계에 제목이 없습니다.'}\n\n`;
    }
    case 'issueReference': return `[${String(node.attrs?.label || node.attrs?.issueId || '업무').replace(/([\\\[\]])/g, '\\$1')}](#/all/issues?issue=${encodeURIComponent(String(node.attrs?.issueId || ''))})\n\n`;
    case 'documentReference': return `[${String(node.attrs?.label || node.attrs?.documentId || '문서').replace(/([\\\[\]])/g, '\\$1')}](#/all/documents/${encodeURIComponent(String(node.attrs?.documentId || ''))})\n\n`;
    case 'documentInclude': return `> 문서 포함: [${String(node.attrs?.label || node.attrs?.documentId || '문서').replace(/([\\\[\]])/g, '\\$1')}](#/all/documents/${encodeURIComponent(String(node.attrs?.documentId || ''))})\n\n`;
    case 'documentExcerpt': {
      const title = node.attrs?.hidden === true ? '**발췌 구역 · 원본 숨김**' : '**발췌 구역**';
      const body = inline().trim();
      return [title, ...(body ? ['', ...body.split('\n')] : [])].map(line => line ? `> ${line}` : '>').join('\n') + '\n\n';
    }
    case 'documentExcerptInclude': {
      const id = String(node.attrs?.documentId ?? '');
      const label = String(node.attrs?.label || id || '문서').replace(/\s+/g, ' ').replace(/([\\`*_\[\]<>])/g, '\\$1');
      const href = encodeURIComponent(id).replace(/\(/g, '%28').replace(/\)/g, '%29');
      return `> 문서 발췌 포함 · [${label}](#/all/documents/${href})${node.attrs?.noPanel === true ? ' · 원본 안내 숨김' : ''}\n\n`;
    }
    case 'documentRevisionInclude': {
      const documentId = encodeURIComponent(String(node.attrs?.documentId || ''));
      const revisionId = encodeURIComponent(String(node.attrs?.revisionId || ''));
      const label = String(node.attrs?.label || '문서').replace(/\s+/g, ' ').replace(/([\\`*_\[\]<>])/g, '\\$1');
      return `> 문서 버전 포함 · ${label} · 문서 ID ${documentId} · 버전 ID ${revisionId}\n\n`;
    }
    case 'issueList':
    case 'issueSummary': {
      const projectId = String(node.attrs?.projectId || '');
      const savedViewId = typeof node.attrs?.savedViewId === 'string' ? node.attrs.savedViewId : null;
      const escape = (value: string) => value.replace(/\s+/g, ' ').replace(/([\\`*_\[\]<>])/g, '\\$1');
      const blockLabel = node.type === 'issueSummary' ? '업무 현황' : '업무 목록';
      const label = escape(String(node.attrs?.label || projectId || blockLabel));
      const path = encodeURIComponent(projectId).replace(/\(/g, '%28').replace(/\)/g, '%29');
      const groupBy = isIssueSummaryGroupBy(node.attrs?.groupBy) ? node.attrs.groupBy : 'status';
      const group = node.type === 'issueSummary' ? ` · ${ISSUE_SUMMARY_GROUP_LABELS[groupBy]} 기준` : '';
      const prefix = node.type === 'issueSummary' ? '업무 현황 ·' : '업무 목록:';
      return `> ${prefix} [${label}](#/${path}/issues)${savedViewId ? ` · 공유 보기 ${escape(savedViewId)}` : ''}${group}\n\n`;
    }
    case 'details': return `<details>\n${inline()}</details>\n\n`;
    case 'detailsSummary': return `<summary>${summaryHtml(node)}</summary>\n\n`;
    case 'detailsContent': return inline();
    case 'callout': {
      const variant = isCalloutVariant(node.attrs?.variant) ? node.attrs.variant : 'info';
      const title = String(node.attrs?.title ?? '').replace(/\s+/g, ' ').replace(/([\\`*_\[\]<>])/g, '\\$1').trim();
      const heading = `**${CALLOUT_LABELS[variant]}${title ? ' · ' + title : ''}**`;
      const body = inline().trim();
      return (body ? `${heading}\n\n${body}` : heading).split('\n').map(line => line ? '> ' + line : '>').join('\n') + '\n\n';
    }
    case 'statusBadge': return summaryHtml(node);
    case 'horizontalRule': return '\n---\n\n';
    case 'codeBlock': return '```' + (node.attrs?.language || '') + '\n' + contentText(node).trimEnd() + '\n```\n\n';
    case 'blockquote': return inline().trim().split('\n').map(line => '> ' + line).join('\n') + '\n\n';
    case 'bulletList': return (node.content || []).map(child => '- ' + render(child).trim().replace(/\n/g, '\n  ')).join('\n') + '\n\n';
    case 'orderedList': return (node.content || []).map((child, index) => `${Number(node.attrs?.start || 1) + index}. ` + render(child).trim().replace(/\n/g, '\n   ')).join('\n') + '\n\n';
    case 'taskList': return inline() + '\n';
    case 'taskItem': return `- [${node.attrs?.checked ? 'x' : ' '}] ` + inline().trim() + '\n';
    case 'image': return `![${String(node.attrs?.alt || '').replace(/\]/g, '\\]')}](${String(node.attrs?.src || '').replace(/[()]/g, encodeURIComponent)})\n\n`;
    case 'table': {
      const table = renderStandaloneDocumentTableMarkdown(node, headings);
      return table ? `${table}\n\n` : '';
    }
    default: return inline();
  }
}

export { downloadText as downloadDocument } from '../lib/download';
