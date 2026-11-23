import { lexer, type MarkedToken, type Token, type Tokens } from 'marked';
import { projectMarkdownArchiveTable, type MarkdownArchiveTableHeading } from './document-markdown-archive-table.js';
import type { MarkdownArchiveHtmlNode } from './document-markdown-archive.js';
import { markdownImportSectionId } from './document-sections.js';
import type { RichContent } from './types.js';

export const MAX_MARKDOWN_IMPORT_BYTES = 512 * 1024;
const maxDepth = 60;
const maxNodes = 30_000;
const maxDocumentBytes = 8 * 1024 * 1024;
const boundsMessage = '문서 블록이나 중첩이 너무 많습니다. Markdown 파일을 나누어 주세요.';

const messages = {
  headingLevel: '4~6단계 제목은 3단계 제목으로 가져옵니다.',
  html: 'HTML 마크업은 원문 텍스트로 가져옵니다.',
  image: '이미지는 대체 텍스트와 확인 가능한 원본 링크로 가져옵니다.',
  relativeLink: '원본 주소를 확인할 수 없는 상대 링크는 텍스트로 가져옵니다.',
  unsafeLink: '사용할 수 없는 주소의 링크는 제목만 가져옵니다.',
  unsupported: '변환할 수 없는 Markdown 요소는 원문 텍스트로 가져옵니다.',
  numberedTask: '번호 목록에 포함된 체크 항목은 체크리스트로 가져옵니다.',
} as const;
type WarningCode = keyof typeof messages;
type Mark = NonNullable<RichContent['marks']>[number];
type Destination = { href: string; imageSrc?: string };
type HeadingSource = { node: Tokens.Heading; title: string; explicitId?: string } |
  { token: Token; table: MarkdownArchiveHtmlNode; headings: MarkdownArchiveTableHeading[] };
interface MarkdownArchiveConversion {
  exportedTitle?: boolean;
  sectionMarkers?: boolean;
  parseTable?: (html: string) => MarkdownArchiveHtmlNode | undefined;
  resolve: (destination: string) => Destination | undefined;
}
const sectionMarker = /^<a id="([a-zA-Z0-9][a-zA-Z0-9_-]{0,79})" name="\1"><\/a>$/;

const entityValues: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '©', reg: '®',
};
function decodeText(value: string) {
  return value.replace(/&([A-Za-z]+);/g, (raw, name: string) => Object.hasOwn(entityValues, name) ? entityValues[name] : raw);
}

const destinationEntities: Record<string, string> = { ...entityValues, colon: ':', Tab: '\t', NewLine: '\n' };
function decodeDestination(value: string) {
  return value.replace(/&(?:#(\d{1,7})|#[xX]([\da-fA-F]{1,6})|([A-Za-z]+));/g,
    (raw, decimal?: string, hex?: string, name?: string) => {
      if (name !== undefined) return Object.hasOwn(destinationEntities, name) ? destinationEntities[name] : raw;
      const point = decimal === undefined ? Number.parseInt(hex!, 16) : Number(decimal);
      return !point || point > 0x10ffff || point >= 0xd800 && point <= 0xdfff ? '\uFFFD' : String.fromCodePoint(point);
    });
}

function textNode(text: string, marks: Mark[] = []): RichContent[] {
  return text ? [{ type: 'text', text, ...(marks.length ? { marks } : {}) }] : [];
}

function paragraph(content: RichContent[] = []): RichContent {
  return { type: 'paragraph', ...(content.length ? { content } : {}) };
}

function literalLines(raw: string, marks: Mark[] = []): RichContent[] {
  return raw.replace(/\n$/, '').split('\n').flatMap((line, index): RichContent[] => [
    ...(index ? [{ type: 'hardBreak' }] : []), ...textNode(line, marks),
  ]);
}

function sourceLocation(value?: string): URL | null {
  if (!value?.trim()) return null;
  const address = value.trim();
  try {
    const url = new URL(address);
    if (!/^https?:\/\/[^/]/i.test(address) || /[\\\u0000-\u001f\u007f]/.test(address) || url.username || url.password) throw new Error();
    url.hash = '';
    url.search = '';
    return url;
  } catch {
    throw new Error('원본 문서 주소는 자격 증명이 없는 HTTP 또는 HTTPS 주소로 입력해 주세요.');
  }
}

/** Labels are used as plain text and to index GitLab-style heading fragments. */
function inlineLabel(tokens: Token[], depth = 0): string {
  if (depth > maxDepth) throw new Error(boundsMessage);
  return tokens.map(raw => {
    const token = raw as MarkedToken;
    switch (token.type) {
      case 'text': return token.tokens?.length ? inlineLabel(token.tokens, depth + 1) : decodeText(token.text);
      case 'escape': case 'codespan': return token.text;
      case 'br': return ' ';
      case 'strong': case 'em': case 'del': case 'link': case 'image': return inlineLabel(token.tokens, depth + 1);
      case 'html': return '';
      default: return raw.raw;
    }
  }).join('');
}

class MarkdownConversion {
  private readonly warningCounts = new Map<WarningCode, number>();
  private readonly sections = new Map<Tokens.Heading | MarkdownArchiveHtmlNode, string>();
  private readonly tables = new Map<Token, MarkdownArchiveHtmlNode>();
  private readonly anchors = new Map<string, string>();
  private readonly explicitAnchors = new Map<string, string>();
  private readonly omittedBlocks = new Set<Token>();
  private readonly nextAnchorSuffix = new Map<string, number>();
  suggestedTitle = '';

  constructor(private readonly sourceUrl: URL | null, private readonly archive?: MarkdownArchiveConversion) {}

  get warnings() {
    return [...this.warningCounts].map(([code, count]) => ({ code, count, message: messages[code] }));
  }

  private warn(code: WarningCode) {
    this.warningCounts.set(code, (this.warningCounts.get(code) ?? 0) + 1);
  }

  sectionId(fragment: string): string | undefined {
    return this.explicitAnchors.get(fragment) ?? this.anchors.get(fragment.normalize('NFC'));
  }

  private indexHeading(node: Tokens.Heading | MarkdownArchiveHtmlNode, title: string, explicitId?: string): void {
    if (!this.suggestedTitle && title) {
      this.suggestedTitle = title.replace(/\s+/gu, ' ').slice(0, 240).toWellFormed();
    }
    const id = markdownImportSectionId(this.sections.size + 1);
    this.sections.set(node, id);
    if (explicitId) {
      if (this.explicitAnchors.has(explicitId)) throw new Error('문서에서 같은 절 ID를 두 번 사용할 수 없습니다.');
      this.explicitAnchors.set(explicitId, id);
    }
    const base = title.normalize('NFC').toLowerCase().replace(/\s/gu, ' ').replace(/[^\p{L}\p{N} _-]/gu, '').replaceAll(' ', '-');
    if (!base) return;
    let slug = base;
    let next = this.nextAnchorSuffix.get(base) ?? 1;
    while (this.anchors.has(slug)) slug = `${base}-${next++}`;
    this.nextAnchorSuffix.set(base, next);
    this.anchors.set(slug, id);
  }

  private collectHeadings(tokens: Token[], sources: HeadingSource[], depth: number): void {
    if (depth > maxDepth) throw new Error(boundsMessage);
    let marker: { token: Token; id: string } | undefined;
    if (depth === 0 && this.archive?.exportedTitle && tokens[0]?.type === 'heading' && (tokens[0] as Tokens.Heading).depth === 1) {
      const title = tokens[0] as Tokens.Heading;
      this.suggestedTitle = inlineLabel(title.tokens).trim().replace(/\s+/gu, ' ').slice(0, 240).toWellFormed();
      this.omittedBlocks.add(title);
    }
    for (const raw of tokens) {
      if (raw.type === 'space' || this.omittedBlocks.has(raw)) continue;
      const token = raw as MarkedToken;
      if (this.archive?.sectionMarkers && (token.type === 'paragraph' || token.type === 'html')) {
        const explicit = sectionMarker.exec(token.raw.trim())?.[1];
        if (explicit) { marker = { token, id: explicit }; continue; }
      }
      if (token.type === 'blockquote') this.collectHeadings(token.tokens, sources, depth + 1);
      if (token.type === 'list') {
        for (const item of token.items) this.collectHeadings(item.tokens, sources, depth + 1);
      }
      if (token.type === 'heading') {
        sources.push({ node: token, title: inlineLabel(token.tokens).trim(), explicitId: marker?.id });
        if (marker) this.omittedBlocks.add(marker.token);
      } else if (token.type === 'html') {
        const table = this.archive?.parseTable?.(token.raw);
        const projected = table && projectMarkdownArchiveTable(table);
        if (table && projected) sources.push({ token, table, headings: projected.headings });
      }
      marker = undefined;
    }
  }

  indexHeadings(tokens: Token[]): void {
    const sources: HeadingSource[] = [];
    this.collectHeadings(tokens, sources, 0);
    const explicitIds = new Map<string, number>();
    for (const source of sources) {
      for (const { explicitId } of 'table' in source ? source.headings : [source]) {
        if (explicitId) explicitIds.set(explicitId, (explicitIds.get(explicitId) ?? 0) + 1);
      }
    }
    for (const source of sources) {
      if ('table' in source) {
        if (source.headings.some(({ explicitId }) => explicitId && explicitIds.get(explicitId) !== 1)) continue;
        this.tables.set(source.token, source.table);
        for (const { node, title, explicitId } of source.headings) this.indexHeading(node, title, explicitId);
      } else {
        this.indexHeading(source.node, source.title, source.explicitId);
      }
    }
  }

  private resolveLink(raw: string): { href: string | null; preservePath?: true } {
    const address = raw.trim();
    if (/[\\\u0000-\u001f\u007f]/.test(raw) || /^\/\//.test(address)) {
      this.warn('unsafeLink');
      return { href: null };
    }
    const packaged = this.archive?.resolve(address);
    if (packaged) return packaged;
    if (address.startsWith('#')) {
      try {
        const match = this.sectionId(decodeURIComponent(address.slice(1)));
        if (match) return { href: `#${match}` };
      } catch {
        // Keep a malformed or unrecognized fragment as original text or a source link.
      }
    }
    const absolute = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(address);
    if (!absolute && !this.sourceUrl) {
      this.warn('relativeLink');
      return { href: null, preservePath: true };
    }
    try {
      const url = absolute ? new URL(address) : new URL(address, this.sourceUrl!);
      if (url.protocol === 'mailto:' && url.pathname && !/%0[ad]/i.test(address)) return { href: url.href };
      if ((url.protocol === 'https:' || url.protocol === 'http:') && url.hostname && !url.username && !url.password &&
          (!absolute || /^https?:\/\/[^/]/i.test(address))) return { href: url.href };
    } catch {
      // Keep link text when a destination cannot be parsed.
    }
    this.warn('unsafeLink');
    return { href: null };
  }

  private inlineImage(tokens: Token[]): RichContent | null {
    if (!this.archive || tokens.length !== 1 || tokens[0].type !== 'image') return null;
    const image = tokens[0] as Tokens.Image;
    const raw = decodeDestination(image.href);
    const src = this.resolveArchiveImage(raw);
    if (!src) return null;
    const alt = inlineLabel(image.tokens).replace(/\s+/gu, ' ').trim();
    return { type: 'image', attrs: { src, alt, ...(image.title ? { title: image.title } : {}) } };
  }

  private resolveArchiveImage(raw: string): string | undefined {
    if (/[\\\u0000-\u001f\u007f]/.test(raw) || /^\/\//.test(raw.trim())) return undefined;
    return this.archive?.resolve(raw.trim())?.imageSrc;
  }

  private inline(tokens: Token[], depth: number, marks: Mark[] = [], literal = false): RichContent[] {
    if (depth > maxDepth) throw new Error(boundsMessage);
    const content: RichContent[] = [];
    const write = (text: string, styles = marks) => content.push(...textNode(text, styles));
    const descend = (children: Token[], style?: Mark, literalText = literal) => {
      const accumulated = style && !marks.some(mark => mark.type === style.type) ? [...marks, style] : marks;
      for (const child of this.inline(children, depth + 1, accumulated, literalText)) content.push(child);
    };
    for (const raw of tokens) {
      const token = raw as MarkedToken;
      switch (token.type) {
        case 'text':
          if (token.tokens?.length) descend(token.tokens);
          else write((literal ? token.text : decodeText(token.text)).replaceAll('\n', ' '));
          break;
        case 'escape': write(token.text); break;
        case 'strong': descend(token.tokens, { type: 'bold' }); break;
        case 'em': descend(token.tokens, { type: 'italic' }); break;
        case 'del': descend(token.tokens, { type: 'strike' }); break;
        case 'codespan': {
          // The editor excludes other marks from code spans. Keep a linked span clickable.
          const link = marks.find(mark => mark.type === 'link');
          write(token.text, link ? [link] : [{ type: 'code' }]);
          break;
        }
        case 'br': content.push({ type: 'hardBreak' }); break;
        case 'link': {
          const { href, preservePath } = this.resolveLink(token.autolink ? token.href : decodeDestination(token.href));
          const style = href ? { type: 'link', attrs: { href, ...(token.title ? { title: token.title } : {}) } } : undefined;
          if (token.tokens.length) descend(token.tokens, style, token.autolink === true);
          else write(href ?? '링크', style ? [...marks.filter(mark => mark.type !== 'link'), style] : marks);
          if (preservePath && token.href) write(` (${token.href})`);
          break;
        }
        case 'image': {
          this.warn('image');
          const { href, preservePath } = this.resolveLink(decodeDestination(token.href));
          const alt = inlineLabel(token.tokens).replace(/\s+/gu, ' ').trim();
          const label = alt ? `${alt} (이미지)` : '이미지';
          const link = href && !marks.some(mark => mark.type === 'link') ? { type: 'link', attrs: { href } } : null;
          write(label, link ? [...marks, link] : marks);
          if (preservePath && token.href) write(` (${token.href})`);
          break;
        }
        case 'html':
          this.warn('html');
          for (const line of literalLines(token.raw, marks)) content.push(line);
          break;
        default:
          this.warn('unsupported');
          for (const line of literalLines(raw.raw, marks)) content.push(line);
      }
    }
    return content;
  }

  private list(token: Tokens.List, depth: number): RichContent[] {
    const groups: RichContent[] = [];
    for (const [index, item] of token.items.entries()) {
      const type = item.task ? 'taskList' : token.ordered ? 'orderedList' : 'bulletList';
      if (item.task && token.ordered) this.warn('numberedTask');
      let group = groups.at(-1);
      if (group?.type !== type) {
        const start = typeof token.start === 'number' ? token.start : 1;
        group = { type, content: [], ...(type === 'orderedList' ? { attrs: { start: start + index } } : {}) };
        groups.push(group);
      }
      const content = this.blocks(item.tokens, depth + 1);
      if (content[0]?.type !== 'paragraph') content.unshift(paragraph());
      group.content!.push(item.task
        ? { type: 'taskItem', attrs: { checked: Boolean(item.checked) }, content }
        : { type: 'listItem', content });
    }
    return groups;
  }

  blocks(tokens: Token[], depth = 0): RichContent[] {
    if (depth > maxDepth) throw new Error(boundsMessage);
    const content: RichContent[] = [];
    for (const raw of tokens) {
      if (this.omittedBlocks.has(raw)) continue;
      const token = raw as MarkedToken;
      switch (token.type) {
        case 'space': case 'def': case 'checkbox': break;
        case 'heading': {
          if (token.depth > 3) this.warn('headingLevel');
          const inline = this.inline(token.tokens, depth + 1);
          content.push({ type: 'heading', attrs: { level: Math.min(3, token.depth), sectionId: this.sections.get(token) },
            ...(inline.length ? { content: inline } : {}) });
          break;
        }
        case 'paragraph':
          content.push(this.inlineImage(token.tokens) ?? paragraph(this.inline(token.tokens, depth + 1)));
          break;
        case 'text':
          content.push(paragraph(token.tokens?.length ? this.inline(token.tokens, depth + 1) : textNode(decodeText(token.text))));
          break;
        case 'code': {
          const language = token.lang?.trim().split(/\s+/, 1)[0];
          content.push({ type: 'codeBlock', ...(language ? { attrs: { language } } : {}),
            ...(token.text ? { content: textNode(token.text) } : {}) });
          break;
        }
        case 'hr': content.push({ type: 'horizontalRule' }); break;
        case 'blockquote': {
          const children = this.blocks(token.tokens, depth + 1);
          content.push({ type: 'blockquote', content: children.length ? children : [paragraph()] });
          break;
        }
        case 'list':
          for (const list of this.list(token, depth)) content.push(list);
          break;
        case 'table':
          content.push({ type: 'table', content: [token.header, ...token.rows].map((row, index) => ({
            type: 'tableRow', content: row.map((cell, column) => ({
              type: index === 0 ? 'tableHeader' : 'tableCell',
              ...(token.align[column] ? { attrs: { align: token.align[column] } } : {}),
              content: [paragraph(this.inline(cell.tokens, depth + 1))],
            })),
          })) });
          break;
        case 'html': {
          const table = this.tables.get(raw);
          if (table) {
            const projected = projectMarkdownArchiveTable(table, {
              sectionId: node => this.sections.get(node),
              resolveLink: value => this.resolveLink(value),
              resolveImage: value => this.resolveArchiveImage(value),
              warn: code => this.warn(code),
            });
            if (projected) {
              content.push(projected.content);
              break;
            }
          }
          this.warn('html');
          content.push(paragraph(literalLines(token.raw)));
          break;
        }
        default:
          this.warn('unsupported');
          content.push(paragraph(literalLines(raw.raw)));
      }
    }
    return content;
  }
}

function verifyConvertedSize(root: RichContent) {
  const pending = [{ node: root, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++count > maxNodes || depth > maxDepth) throw new Error(boundsMessage);
    for (const child of node.content ?? []) pending.push({ node: child, depth: depth + 1 });
  }
  if (new TextEncoder().encode(JSON.stringify(root)).byteLength > maxDocumentBytes) throw new Error(boundsMessage);
}

function readMarkdown(source: string, sourceUrl?: string, archive?: MarkdownArchiveConversion) {
  if (source.length > MAX_MARKDOWN_IMPORT_BYTES || new TextEncoder().encode(source).byteLength > MAX_MARKDOWN_IMPORT_BYTES) {
    throw new Error('Markdown 파일은 UTF-8 기준 512KiB까지 가져올 수 있습니다.');
  }
  if (!source.isWellFormed() || source.includes('\u0000')) throw new Error('올바른 Markdown 텍스트를 확인해 주세요.');
  if (!source.trim() && !archive) throw new Error('가져올 Markdown 내용을 입력해 주세요.');
  const conversion = new MarkdownConversion(sourceLocation(sourceUrl), archive);
  let tokens: Token[];
  try {
    tokens = lexer(source.replace(/^\uFEFF/, ''), { gfm: true });
  } catch (error) {
    if (error instanceof RangeError) throw new Error(boundsMessage);
    throw new Error('Markdown 구조를 읽을 수 없습니다. 원문을 확인해 주세요.');
  }
  conversion.indexHeadings(tokens);
  return {
    suggestedTitle: conversion.suggestedTitle,
    sectionId: (fragment: string) => conversion.sectionId(fragment),
    build() {
      const body = conversion.blocks(tokens);
      if (!body.length && !archive) throw new Error('가져올 수 있는 Markdown 본문이 없습니다.');
      const content: RichContent = { type: 'doc', content: body.length ? body : [paragraph()] };
      verifyConvertedSize(content);
      return { content, suggestedTitle: conversion.suggestedTitle, warnings: conversion.warnings };
    },
  };
}

export function previewMarkdownImport(source: string, sourceUrl?: string) {
  return readMarkdown(source, sourceUrl).build();
}

export function readArchiveMarkdown(source: string, options: MarkdownArchiveConversion) {
  return readMarkdown(source, undefined, options);
}
