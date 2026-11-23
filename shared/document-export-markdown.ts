import { parse, parseInline } from 'marked';
import { documentChildListDescription, normalizeDocumentChildListOptions } from './document-child-list.js';
import { documentLabelListDescription, normalizeDocumentLabelListOptions } from './document-label-list.js';
import {
  CALLOUT_LABELS, ISSUE_SUMMARY_GROUP_LABELS, STATUS_BADGE_TONE_LABELS, documentPlainText, documentTocOptions,
  isCalloutVariant, isDocumentTocLevel, isIssueSummaryGroupBy, isStatusBadgeTone, MAX_DOCUMENT_TABLE_SPAN,
} from './document-nodes.js';
import { documentNodes } from './document-references.js';
import { isDocumentSectionId, outlineHeadingTitle } from './document-sections.js';
import { inlineAttachmentIdFromUrl } from './inline-attachment.js';
import type { DocPage, RichContent } from './types.js';

type DocumentTarget = { sectionId?: string; revisionId?: string };
type AttachmentKind = 'inline-image' | 'attachment' | 'attachment-version';

export interface DocumentMarkdownExportResolvers {
  browserOrigin?: string;
  document(documentId: string, target?: DocumentTarget): string | undefined;
  attachment(id: string, kind: AttachmentKind): string | undefined;
}

export interface TicketMarkdownLinks {
  href(href: string): string | undefined;
  reference(kind: 'issue' | 'document', id: string): string | undefined;
}

const diagnosticMessages = {
  attachment_unavailable: '이 문서에 포함된 첨부파일을 오프라인 경로에 연결하지 못했습니다.',
  document_outside_export: '문서 또는 절이 이번 내보내기 범위에 없습니다.',
  dynamic_block: '현재 작업공간에서 계산하는 블록의 조건만 보존했습니다.',
  external_image: '오프라인 파일로 확인할 수 없는 이미지를 제외했습니다.',
  external_link: '오프라인 대상이 없는 주소는 링크 없이 표시했습니다.',
  issue_reference: '업무 참조의 표시 이름만 보존했습니다.',
  layout_linearized: '단 안의 블록을 왼쪽 단부터 순서대로 내보냈습니다.',
  live_include: '최신 문서에 따라 바뀌는 포함 본문을 별도로 펼치지 않았습니다.',
  pinned_revision_unavailable: '요청한 문서 저장본이 이번 내보내기 범위에 없습니다.',
  unsupported_node: '이 블록의 텍스트만 보존했습니다.',
} as const;

export interface DocumentMarkdownExportDiagnostic {
  code: keyof typeof diagnosticMessages;
  nodeType: string;
  message: string;
}

type Heading = { level: 1 | 2 | 3; anchor: string; title: string };
type StandaloneTable = { headings?: ReadonlyMap<RichContent, { anchor: string; level: number; title: string }> };
const emptyExportResolvers: DocumentMarkdownExportResolvers = { document: () => undefined, attachment: () => undefined };

const literal = (value: unknown) => typeof value === 'string' ? value : '';
const cleanText = (value: string) => value.toWellFormed().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '\ufffd');
const singleLine = (value: string) => cleanText(value).replace(/[\r\n\t\u2028\u2029]+/gu, ' ');

export function escapeMarkdownText(value: string): string {
  return singleLine(value).replace(/[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/gu, '\\$&');
}

const htmlText = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

// The caller constructs destinations from ZIP paths. Do not allow an absolute URI even if one slips through.
function localHref(href: string | undefined): string | undefined {
  if (!href || href.startsWith('/') || /^[a-z][a-z0-9+.-]*:/iu.test(href) ||
      /[\\\u0000-\u001f\u007f]/u.test(href) || href.trim() !== href) return undefined;
  return href.replace(/[ !"&'()<>[\]`{}|]/gu, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeMarkdownHref(href: string | undefined): string | undefined {
  return href?.replace(/[ !"'()<>`{}|]/gu, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function standaloneHref(href: string, image = false): string | undefined {
  if (!href || href.trim() !== href || href.startsWith('//') || /[\\\u0000-\u001f\u007f]/u.test(href)) return;
  const scheme = /^[a-z][a-z\d+.-]*:/iu.exec(href)?.[0].toLowerCase();
  if (scheme === 'http:' || scheme === 'https:') {
    try {
      const url = new URL(href);
      if (url.username || url.password) return;
    } catch { return; }
  } else if (image ? !href.startsWith('/') : scheme ? scheme !== 'mailto:' && scheme !== 'tel:' : /^[^/?#]*:/u.test(href)) return;
  return encodeMarkdownHref(href);
}

function link(body: string, href: string, title?: string): string {
  const caption = title ? ` "${htmlText(singleLine(title)).replaceAll('\\', '\\\\')}"` : '';
  return `[${body}](${href}${caption})`;
}

const compactHtml = (markdown: string) => parse(markdown, { async: false, gfm: true }).trim().replaceAll('\n', '&#10;');

function longestRun(text: string, character: '`' | '~'): number {
  const runs = character === '`' ? /`+/gu : /~+/gu;
  let longest = 0;
  for (const run of text.matchAll(runs)) longest = Math.max(longest, run[0].length);
  return longest;
}

function inlineCode(text: string, table: boolean): string {
  if ((/ $|^ /u.test(text) && !text.trim()) || (table && text.includes('|'))) {
    return `<code>${htmlText(text).replaceAll('|', '&#124;')}</code>`;
  }
  const fence = '`'.repeat(longestRun(text, '`') + 1);
  const margin = /[ `]$|^[ `]/u.test(text) ? ' ' : '';
  return `${fence}${margin}${text}${margin}${fence}`;
}

function blockCode(node: RichContent): string {
  const body = cleanText((node.content ?? []).map(child => child.text ?? '').join('')).replace(/\r\n?/gu, '\n');
  const ticks = longestRun(body, '`');
  const tildes = longestRun(body, '~');
  const fence = ticks <= tildes ? '`'.repeat(Math.max(3, ticks + 1)) : '~'.repeat(Math.max(3, tildes + 1));
  const language = literal(node.attrs?.language);
  return `${fence}${/^[\w+.-]{1,40}$/u.test(language) ? language : ''}\n${body}${body.endsWith('\n') ? '' : '\n'}${fence}`;
}

const quote = (body: string) => body.split('\n').map(line => line ? `> ${line}` : '>').join('\n');
const anchorTag = (id: string) => `<a id="${id}" name="${id}"></a>`;

function outline(content: RichContent): Map<RichContent, Heading> {
  const headings = [...documentNodes(content)].filter(node => node.type === 'heading');
  const reserved = new Set(headings.flatMap(node => isDocumentSectionId(node.attrs?.sectionId) ? [node.attrs.sectionId] : []));
  let counter = 0;
  return new Map(headings.map(node => {
    const level = node.attrs?.level;
    let anchor = literal(node.attrs?.sectionId);
    if (!isDocumentSectionId(anchor)) {
      do { anchor = `section-${++counter}`; } while (reserved.has(anchor));
    }
    return [node, { anchor, level: isDocumentTocLevel(level) ? level : 3, title: outlineHeadingTitle(documentPlainText(node)) }];
  }));
}

function documentTarget(href: string): { id: string; target?: DocumentTarget } | undefined {
  const hash = href.startsWith('/#') ? href.slice(1) : href;
  const match = /^#\/[^/?#]+\/documents\/([^/?#]+)(?:\?([^#]*))?$/u.exec(hash);
  if (!match) return undefined;
  const query = new URLSearchParams(match[2]);
  const section = query.get('section');
  const revision = query.get('revision');
  const publication = query.get('publication');
  if ([...query.keys()].some(key => !['section', 'revision', 'publication'].includes(key) || query.getAll(key).length !== 1) ||
      (section !== null && !isDocumentSectionId(section)) || ((publication === null) !== (revision === null)) ||
      (publication !== null && publication !== 'published' && publication !== 'review') || (revision !== null && !revision)) return undefined;
  try {
    const id = decodeURIComponent(match[1]);
    if (!id || /[\u0000-\u001f\u007f]/u.test(id)) return undefined;
    return { id, ...(section || revision ? { target: { ...(section ? { sectionId: section } : {}), ...(revision ? { revisionId: revision } : {}) } } : {}) };
  } catch {
    return undefined;
  }
}

const attachmentUrl = /^\/api\/(attachments|attachment-versions)\/([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})\/(content|download)(\?inline=1)?$/iu;

function sameOriginAddress(href: string, origin: string | undefined): string {
  if (!origin || !/^https?:\/\/[^/]/iu.test(href) || /[\\\u0000-\u0020\u007f]/u.test(href)) return href;
  try {
    const url = new URL(href);
    if (url.origin === origin && !url.username && !url.password) return `${url.pathname}${url.search}${url.hash}`;
  } catch { /* Invalid destinations keep their text and diagnostics. */ }
  return href;
}

function attachmentTarget(href: string): { id: string; kind: AttachmentKind } | undefined {
  const match = attachmentUrl.exec(href);
  if (!match) return undefined;
  const [, group, id, action, inline] = match;
  if (group === 'attachments' && action === 'content') return { id, kind: inline ? 'inline-image' : 'attachment' };
  if (group === 'attachment-versions' && action === 'download') return { id, kind: inline ? 'inline-image' : 'attachment-version' };
  return undefined;
}

function listItem(marker: string, body: string): string {
  const indent = ' '.repeat(marker.startsWith('- [') ? 2 : marker.length);
  return body.split('\n').map((line, index) => index === 0 ? `${marker}${line}` : line ? `${indent}${line}` : '').join('\n');
}

function cellSpan(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) ? Math.min(MAX_DOCUMENT_TABLE_SPAN, Math.max(1, value)) : 1;
}

const alignment = (value: unknown) => value === 'center' || value === 'left' || value === 'right' ? value : null;

const inlineWrappers: Record<string, [marker: string, tag: string]> = {
  bold: ['**', 'strong'], italic: ['*', 'em'], strike: ['~~', 'del'], underline: ['', 'u'],
};

class DocumentMarkdownRenderer {
  readonly diagnostics: DocumentMarkdownExportDiagnostic[] = [];
  private readonly headings: Map<RichContent, Heading>;
  private readonly anchors: Set<string>;

  constructor(content: RichContent, private readonly resolve: DocumentMarkdownExportResolvers, private readonly ticket?: TicketMarkdownLinks,
    private readonly standalone?: StandaloneTable) {
    this.headings = outline(content);
    if (standalone?.headings?.size) {
      const allHeadings = new Map<RichContent, Heading>();
      for (const [node, heading] of standalone.headings) {
        allHeadings.set(node, { ...heading, level: isDocumentTocLevel(heading.level) ? heading.level : 3 });
      }
      for (const [node, heading] of this.headings) {
        if (!allHeadings.has(node)) allHeadings.set(node, heading);
      }
      this.headings = allHeadings;
    }
    this.anchors = new Set([...this.headings.values()].map(heading => heading.anchor));
  }

  private warn(code: DocumentMarkdownExportDiagnostic['code'], node: RichContent) {
    this.diagnostics.push({ code, nodeType: node.type, message: diagnosticMessages[code] });
  }

  private destination(raw: unknown, node: RichContent): string | undefined {
    if (this.ticket) return encodeMarkdownHref(this.ticket.href(literal(raw)));
    if (this.standalone) return standaloneHref(literal(raw));
    const href = sameOriginAddress(literal(raw), this.resolve.browserOrigin);
    const attachment = attachmentTarget(href);
    if (attachment) {
      const local = localHref(this.resolve.attachment(attachment.id, attachment.kind));
      if (!local) this.warn('attachment_unavailable', node);
      return local;
    }
    const target = documentTarget(href);
    if (target || href.startsWith('#')) {
      const fragment = href.slice(1);
      const local = target ? localHref(this.resolve.document(target.id, target.target)) :
        this.anchors.has(fragment) ? href : undefined;
      if (!local) this.warn('document_outside_export', node);
      return local;
    }
    if (href) this.warn('external_link', node);
    return undefined;
  }

  private inlineNode(node: RichContent, table: boolean, joined: boolean): string {
    if (node.type === 'hardBreak') return table ? this.ticket ? ' ' : '<br>' : '  \n';
    const attrs = node.attrs;
    const text = singleLine(node.type === 'statusBadge'
      ? `[${isStatusBadgeTone(attrs?.tone) && attrs.tone !== 'neutral' ? `${STATUS_BADGE_TONE_LABELS[attrs.tone]} · ` : ''}${literal(attrs?.label) || '상태'}]`
      : node.text ?? '');
    const marks = node.marks ?? [];
    const wrappers = marks.filter(mark => Object.hasOwn(inlineWrappers, mark.type) && (!this.ticket || mark.type !== 'underline'));
    const hasCode = marks.some(mark => mark.type === 'code');
    const [leading, interior, trailing] = /^( *)(.*?)( *)$/u.exec(text)!.slice(1);
    const codeText = this.ticket && table ? text.replaceAll('|', '\\|') : text;
    let body = hasCode && (!this.ticket || codeText.trim()) ? inlineCode(codeText, table && !this.ticket) : escapeMarkdownText(wrappers.length ? interior : text);
    if (body) for (const mark of wrappers) {
      const [marker, tag] = inlineWrappers[mark.type];
      body = this.ticket || (marker && !joined && wrappers.length === 1 && !hasCode) ? `${marker}${body}${marker}` : `<${tag}>${body}</${tag}>`;
    }
    const target = marks.find(mark => mark.type === 'link');
    if (target && body) {
      const href = this.destination(target.attrs?.href, node);
      if (href) body = link(body, href, literal(target.attrs?.title));
    }
    return !hasCode && wrappers.length ? `${leading}${body}${trailing}` : body;
  }

  private inline(nodes: RichContent[], table = false): string {
    return nodes.map((node, index) => {
      const left = nodes[index - 1]?.text?.slice(-1);
      const right = nodes[index + 1]?.text?.[0];
      const joined = Boolean((left && !/\s/u.test(left)) || (right && !/\s/u.test(right)));
      return this.inlineNode(node, table, joined);
    }).join('');
  }

  private reference(node: RichContent): string {
    const attrs = node.attrs;
    const id = literal(attrs?.documentId);
    const label = escapeMarkdownText(literal(attrs?.label) || id || literal(attrs?.issueId) || '참조');
    if (this.ticket) {
      const href = node.type === 'issueReference' ? this.ticket.reference('issue', literal(attrs?.issueId)) : this.ticket.reference('document', id);
      const destination = encodeMarkdownHref(href);
      return destination ? link(label, destination) : label;
    }
    if (node.type === 'issueReference') {
      if (this.standalone && typeof attrs?.issueId === 'string') {
        return link(label, encodeMarkdownHref(`#/all/issues?issue=${encodeURIComponent(attrs.issueId)}`)!);
      }
      this.warn('issue_reference', node);
      return `**업무 참조** · ${label}`;
    }
    if (node.type === 'documentRevisionInclude') {
      const revisionId = literal(attrs?.revisionId);
      const href = revisionId ? localHref(this.resolve.document(id, { revisionId })) : undefined;
      if (!href) this.warn('pinned_revision_unavailable', node);
      return `**문서 버전 포함** · ${href ? link(label, href) : label} · 저장본 ${escapeMarkdownText(revisionId || '미확인')}${href ? '' : ' · 이번 내보내기에 없음'}`;
    }
    const href = this.standalone && id ? encodeMarkdownHref(`#/all/documents/${encodeURIComponent(id)}`) : localHref(this.resolve.document(id));
    const view = href ? link(label, href) : label;
    if (node.type === 'documentReference') {
      if (!href) this.warn('document_outside_export', node);
      return view;
    }
    this.warn('live_include', node);
    if (!href) this.warn('document_outside_export', node);
    return `**${node.type === 'documentExcerptInclude' ? '발췌 포함' : '문서 포함'}** · ${view} · 포함 본문 생략`;
  }

  private image(node: RichContent): string {
    const src = sameOriginAddress(literal(node.attrs?.src), this.resolve.browserOrigin);
    const title = literal(node.attrs?.title);
    const alt = escapeMarkdownText(literal(node.attrs?.alt) || title || '첨부 이미지');
    if (this.ticket) {
      const href = encodeMarkdownHref(this.ticket.href(src));
      return href ? link(alt, href) : alt;
    }
    if (this.standalone) {
      const href = standaloneHref(src, true);
      return href ? `!${link(alt, href, title)}` : alt;
    }
    const attachment = attachmentTarget(src);
    const id = inlineAttachmentIdFromUrl(src) ?? attachment?.id;
    const href = id ? localHref(this.resolve.attachment(id, 'inline-image')) : undefined;
    if (href) {
      return `!${link(alt, href, title)}`;
    }
    this.warn(id ? 'attachment_unavailable' : 'external_image', node);
    return `**이미지** · ${alt} · 이번 내보내기에 없음`;
  }

  private dynamicBlock(node: RichContent): string {
    this.warn('dynamic_block', node);
    const attrs = node.attrs;
    if (node.type === 'documentLabelList') {
      const options = normalizeDocumentLabelListOptions(attrs);
      return `**라벨별 문서 목록** · ${escapeMarkdownText(options ? documentLabelListDescription(options) : '조건 확인 불가')} · 조회 결과 생략`;
    }
    if (node.type === 'documentChildList') {
      const options = normalizeDocumentChildListOptions(attrs);
      return `**하위 문서 목록** · ${escapeMarkdownText(options ? documentChildListDescription(options) : '조건 확인 불가')} · 조회 결과 생략`;
    }
    const summary = node.type === 'issueSummary';
    const groupBy = summary && isIssueSummaryGroupBy(attrs?.groupBy) ? ISSUE_SUMMARY_GROUP_LABELS[attrs.groupBy] : '';
    const conditions = [literal(attrs?.label), literal(attrs?.projectId) && `프로젝트 ${attrs?.projectId}`,
      literal(attrs?.savedViewId) && `공유 보기 ${attrs?.savedViewId}`, groupBy && `집계 ${groupBy}`].filter(Boolean);
    return `**${summary ? '업무 현황' : '업무 목록'}** · ${conditions.length ? `${escapeMarkdownText(conditions.join(' · '))} · ` : ''}조회 결과 생략`;
  }

  private toc(node: RichContent): string {
    const { minLevel, maxLevel, layout } = documentTocOptions(node.attrs);
    const items = [...this.headings.values()].filter(heading => heading.title && heading.level >= minLevel && heading.level <= maxLevel);
    const parents: Heading['level'][] = [];
    const body = items.map(({ level, title, anchor }) => {
      const item = link(escapeMarkdownText(title), `#${anchor}`);
      if (layout === 'flat') return item;
      while (parents.length && parents[parents.length - 1] >= level) parents.pop();
      const indent = '  '.repeat(parents.length);
      parents.push(level);
      return `${indent}- ${item}`;
    });
    return body.length ? `**목차**\n\n${body.join(layout === 'flat' ? ' · ' : '\n')}` : '';
  }

  private table(node: RichContent): string {
    const rows = (node.content ?? []).map(row => row.content ?? []);
    const width = rows[0]?.length;
    if (!width) return '';
    const simple = rows.every((row, index) => row.length === width && row.every(cell =>
      cell.type === (index ? 'tableCell' : 'tableHeader') && cellSpan(cell.attrs?.colspan) === 1 && cellSpan(cell.attrs?.rowspan) === 1 &&
      cell.content?.length === 1 && cell.content[0].type === 'paragraph'));
    if (simple) {
      const rowText = (values: string[]) => `| ${values.join(' | ')} |`;
      const values = rows.map(row => rowText(row.map(cell => this.inline(cell.content?.[0].content ?? [], true))));
      const separators = rows[0].map(cell => {
        const align = alignment(cell.attrs?.align);
        return align ? ({ center: ':---:', left: ':---', right: '---:' })[align] : '---';
      });
      return [values[0], rowText(separators), ...values.slice(1)].join('\n');
    }
    if (this.ticket) {
      const width = Math.max(...rows.map(row => row.length));
      const rowText = (values: string[]) => `| ${values.join(' | ')} |`;
      const values = rows.map(row => rowText(Array.from({ length: width }, (_, index) => {
        const cell = row[index];
        if (!cell) return '';
        return cell.content?.length === 1 && cell.content[0].type === 'paragraph'
          ? this.inline(cell.content[0].content ?? [], true) : escapeMarkdownText(documentPlainText(cell));
      })));
      return [values[0], rowText(Array.from({ length: width }, () => '---')), ...values.slice(1)].join('\n');
    }
    const body = rows.map(row => '<tr>' + row.map(cell => {
      const tag = cell.type === 'tableHeader' ? 'th' : 'td';
      const span = (field: 'colspan' | 'rowspan') => cellSpan(cell.attrs?.[field]) > 1 ? ` ${field}="${cellSpan(cell.attrs?.[field])}"` : '';
      const align = alignment(cell.attrs?.align);
      const cellHtml = compactHtml(this.blocks(cell.content));
      return `<${tag}${span('colspan')}${span('rowspan')}${align ? ` align="${align}"` : ''}>${cellHtml}</${tag}>`;
    }).join('') + '</tr>').join('\n');
    return `<table>\n<tbody>\n${body}\n</tbody>\n</table>`;
  }

  private list(node: RichContent): string {
    const attrs = node.attrs;
    const ordered = node.type === 'orderedList';
    const start = typeof attrs?.start === 'number' && Number.isSafeInteger(attrs.start) && attrs.start >= 0 && attrs.start <= 999_999_999 ? attrs.start : 1;
    if (!this.ticket && ordered && typeof attrs?.type === 'string' && /^[aAiI]$/u.test(attrs.type)) {
      const items = (node.content ?? []).map(item => `<li>${compactHtml(this.blocks(item.content))}</li>`);
      return `<ol start="${start}" type="${attrs.type}">\n${items.join('\n')}\n</ol>`;
    }
    return (node.content ?? []).map((item, index) => {
      const marker = ordered ? `${index === 0 ? start : 1}. ` : node.type === 'taskList' ? `- [${item.attrs?.checked === true ? 'x' : ' '}] ` : '- ';
      return listItem(marker, this.blocks(item.content));
    }).join('\n');
  }

  private block(node: RichContent): string {
    const attrs = node.attrs;
    switch (node.type) {
      case 'doc': case 'listItem': case 'taskItem': case 'detailsContent': case 'tableRow': case 'tableCell': case 'tableHeader': case 'documentColumn':
        return this.blocks(node.content);
      case 'documentColumnLayout':
        if (!this.ticket && (attrs?.border === true || (node.content?.length ?? 0) > 1)) this.warn('layout_linearized', node);
        return this.blocks(node.content);
      case 'text': case 'statusBadge': case 'hardBreak': return this.inline([node]);
      case 'paragraph': case 'detailsSummary': return this.inline(node.content ?? []);
      case 'heading': {
        const heading = this.headings.get(node)!;
        const title = `${'#'.repeat(heading.level)} ${this.inline(node.content ?? [], true)}`;
        return this.ticket ? title : `${anchorTag(heading.anchor)}\n\n${title}`;
      }
      case 'horizontalRule': return '---';
      case 'blockquote': return quote(this.blocks(node.content));
      case 'orderedList': case 'bulletList': case 'taskList': return this.list(node);
      case 'codeBlock': return blockCode(node);
      case 'table': return this.table(node);
      case 'image': return this.image(node);
      case 'callout': {
        const kind = isCalloutVariant(attrs?.variant) ? CALLOUT_LABELS[attrs.variant] : CALLOUT_LABELS.note;
        const title = escapeMarkdownText(literal(attrs?.title));
        return quote([`**${kind}**${title ? ` · ${title}` : ''}`, this.blocks(node.content)].filter(Boolean).join('\n\n'));
      }
      case 'details': {
        const summary = this.inline(node.content?.find(item => item.type === 'detailsSummary')?.content ?? [], true) || '접기';
        const body = this.blocks(node.content?.filter(item => item.type !== 'detailsSummary'));
        if (this.ticket) return quote([`**${summary}**`, body].filter(Boolean).join('\n\n'));
        return `<details>\n<summary>${parseInline(summary, { async: false, gfm: true })}</summary>\n\n${body}\n\n</details>`;
      }
      case 'documentExcerpt': {
        const heading = attrs?.hidden === true ? '**발췌 구역 · 원본 표시에서 숨김**' : '**발췌 구역**';
        return quote([heading, this.blocks(node.content)].filter(Boolean).join('\n\n'));
      }
      case 'issueReference': case 'documentReference': case 'documentInclude': case 'documentExcerptInclude': case 'documentRevisionInclude':
        return this.reference(node);
      case 'documentToc': return this.toc(node);
      case 'issueList': case 'issueSummary': case 'documentLabelList': case 'documentChildList': return this.dynamicBlock(node);
      default:
        this.warn('unsupported_node', node);
        return escapeMarkdownText(documentPlainText(node));
    }
  }

  blocks(nodes: RichContent[] | undefined): string {
    return (nodes ?? []).map(node => this.block(node)).filter(Boolean).join('\n\n');
  }
}

export function renderDocumentExportMarkdown(source: Pick<DocPage, 'id' | 'title' | 'content'>, resolve: DocumentMarkdownExportResolvers): {
  markdown: string; diagnostics: DocumentMarkdownExportDiagnostic[];
} {
  const renderer = new DocumentMarkdownRenderer(source.content, resolve);
  const body = renderer.blocks([source.content]);
  return { markdown: `# ${escapeMarkdownText(source.title)}${body ? `\n\n${body}` : ''}\n`, diagnostics: renderer.diagnostics };
}

export function renderTicketDescriptionMarkdown(content: RichContent, links: TicketMarkdownLinks): string {
  return new DocumentMarkdownRenderer(content, emptyExportResolvers, links).blocks([content]);
}

export function renderStandaloneDocumentTableMarkdown(table: RichContent, headings?: StandaloneTable['headings']): string {
  return new DocumentMarkdownRenderer(table, emptyExportResolvers, undefined, { headings }).blocks([table]);
}
