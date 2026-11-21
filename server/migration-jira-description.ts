import { documentNodes } from '../shared/document-references.js';
import type { LegacyRecord, RichContent } from '../shared/types.js';
import { renderTicketDescriptionMarkdown } from './document-export-markdown.js';
import { convertLegacyContent, type MigrationContentContext, type MigrationContentDiagnostic } from './migration-content.js';

const renderedHtmlTag = /<\/?(?:p|br|h[1-6]|strong|b|em|i|u|del|s|strike|a|code|pre|blockquote|ul|ol|li|table|tr|th|td|img|span|div|hr)\b/i;
const attachmentLink = /^(\/api\/(?:attachments|attachment-versions)\/([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})\/(?:content|download))(?:\?inline=1)?$/iu;
const plainNodes = new Set(['doc', 'paragraph', 'text', 'hardBreak']);

export function jiraRenderedHtmlDescription(record: LegacyRecord): boolean {
  return record.textFormat === 'plain' && record.metadata.descriptionFormat === 'search-rendered-html' && renderedHtmlTag.test(record.text);
}

interface ProjectionOptions {
  resolveReference: MigrationContentContext['resolveReference'];
  ownsAttachment(id: string): boolean;
}

interface JiraDescriptionProjection {
  description: string;
  descriptionFormat?: 'markdown';
  diagnostics: MigrationContentDiagnostic[];
  reliable: boolean;
}

function linkDestination(href: string, ownsAttachment: ProjectionOptions['ownsAttachment']): string | undefined {
  const attachment = attachmentLink.exec(href);
  if (attachment) return ownsAttachment(attachment[2]) ? attachment[1] : undefined;
  if (!/^(?:https?:\/\/[^/]|mailto:)/iu.test(href) || /[\\\u0000-\u0020\u007f]/u.test(href)) return undefined;
  try {
    const url = new URL(href);
    return url.username || url.password ? undefined : url.href;
  } catch { return undefined; }
}

function hasMarkdownContent(body: RichContent, href: (value: string) => string | undefined): boolean {
  for (const node of documentNodes(body)) {
    if (!plainNodes.has(node.type)) return true;
    if (node.marks?.some(mark => ['bold', 'italic', 'strike', 'code'].includes(mark.type) ||
      (mark.type === 'link' && typeof mark.attrs?.href === 'string' && href(mark.attrs.href)))) return true;
  }
  return false;
}

export function projectJiraDescription(record: LegacyRecord, options: ProjectionOptions): JiraDescriptionProjection {
  const renderedHtml = jiraRenderedHtmlDescription(record);
  const input = renderedHtml ? { ...record, textFormat: 'confluence-storage' as const } : record;
  const converted = convertLegacyContent(input, { resolveReference(request) {
    const target = options.resolveReference(request);
    return request.kind === 'attachment' && target && !options.ownsAttachment(target.id) ? null : target;
  } });
  const { diagnostics, content, plainText } = converted;
  const reliable = !diagnostics.some(item => item.severity === 'error' || item.code === 'RAW_CONTENT_FALLBACK');
  if (!reliable) return { description: renderedHtml ? record.text.replace(/\r\n?/gu, '\n') : plainText, diagnostics, reliable };

  const href = (value: string) => linkDestination(value, options.ownsAttachment);
  if (!hasMarkdownContent(content, href)) return { description: plainText, diagnostics, reliable };
  const markdown = renderTicketDescriptionMarkdown(content, { href, reference(kind, id) {
    if (!id) return undefined;
    return kind === 'issue' ? `/#/all/issues?issue=${encodeURIComponent(id)}` : `/#/all/documents/${encodeURIComponent(id)}`;
  } });
  return { description: markdown, descriptionFormat: 'markdown', diagnostics, reliable };
}
