import type { MarkdownArchiveHtmlNode } from './document-markdown-archive.js';
import { isDocumentSectionId } from './document-sections.js';
import type { RichContent } from './types.js';

type HtmlPart = MarkdownArchiveHtmlNode | string;
type Mark = NonNullable<RichContent['marks']>[number];
export type MarkdownArchiveTableHeading = { node: MarkdownArchiveHtmlNode; title: string; explicitId?: string };
type LinkResult = { href: string | null; preservePath?: true };
type TableOptions = {
  sectionId?: (node: MarkdownArchiveHtmlNode) => string | undefined;
  resolveLink?: (href: string) => LinkResult;
  resolveImage?: (src: string) => string | undefined;
  warn?: (code: 'image' | 'headingLevel' | 'numberedTask') => void;
};

const headingTags = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const blockTags = new Set(['p', 'blockquote', 'ul', 'ol', 'pre', 'hr', 'details', 'table', ...headingTags]);
const wrapperMarks = new Map([
  ['strong', 'bold'], ['b', 'bold'], ['em', 'italic'], ['i', 'italic'],
  ['del', 'strike'], ['s', 'strike'], ['strike', 'strike'], ['u', 'underline'],
]);

class UnsupportedTableStructure extends Error {}

function unsupported(): never {
  throw new UnsupportedTableStructure();
}

function checkDepth(depth: number) {
  if (depth > 60) unsupported();
}

const whitespace = (value: HtmlPart) => typeof value === 'string' && !value.trim();
const nonWhitespace = (values: readonly HtmlPart[]) => values.filter(value => !whitespace(value));

function elements(values: readonly HtmlPart[]): MarkdownArchiveHtmlNode[] {
  return nonWhitespace(values).map(value => typeof value === 'string' ? unsupported() : value);
}

function cellAttributes(node: MarkdownArchiveHtmlNode): RichContent['attrs'] {
  const { colspan, rowspan, align } = node.attributes;
  const attrs = {
    ...(colspan === undefined ? {} : { colspan: Number(colspan) }),
    ...(rowspan === undefined ? {} : { rowspan: Number(rowspan) }),
    ...(align === undefined ? {} : { align }),
  };
  // Table geometry and attribute ranges are verified by the archive parser.
  return Object.keys(attrs).length ? attrs : undefined;
}

function textNode(text: string, marks: Mark[] = []): RichContent[] {
  return text ? [{ type: 'text', text, ...(marks.length ? { marks } : {}) }] : [];
}

function paragraph(content: RichContent[] = []): RichContent {
  return { type: 'paragraph', ...(content.length ? { content } : {}) };
}

function explicitHeadingMarker(node: MarkdownArchiveHtmlNode): string | undefined {
  const contents = nonWhitespace(node.children);
  const anchor = node.tag === 'p' && contents.length === 1 ? contents[0] : node;
  if (!anchor || typeof anchor === 'string' || anchor.tag !== 'a' || nonWhitespace(anchor.children).length ||
      Object.keys(anchor.attributes).some(key => key !== 'id' && key !== 'name')) return undefined;
  const { id, name } = anchor.attributes;
  const sectionId = id ?? name;
  return (id === undefined || name === undefined || id === name) && isDocumentSectionId(sectionId) ? sectionId : undefined;
}

function label(values: readonly HtmlPart[], depth: number): string {
  checkDepth(depth);
  return values.map(child => {
    if (typeof child === 'string') return child;
    if (child.tag === 'br') return ' ';
    if (child.tag === 'img') return child.attributes.alt ?? '';
    return label(child.children, depth + 1);
  }).join('');
}

function extractTask(values: readonly HtmlPart[]): { checked: boolean; body: HtmlPart[] } | undefined {
  const index = values.findIndex(value => !whitespace(value));
  const marker = values[index];
  if (!marker || typeof marker === 'string') return undefined;
  if (marker.tag === 'p') {
    // Marked emits the checkbox inside the leading paragraph of a loose item.
    const next = nonWhitespace(marker.children)[0];
    if (typeof next === 'string' || next?.tag !== 'input') return undefined;
    const task = extractTask(marker.children);
    if (!task) return undefined;
    return { checked: task.checked, body: [{ ...marker, children: task.body }, ...values.slice(index + 1)] };
  }
  if (marker.tag !== 'input' || marker.attributes.type !== 'checkbox') return undefined;
  const body = values.slice(index + 1);
  if (typeof body[0] === 'string' && body[0].startsWith(' ')) body[0] = body[0].slice(1);
  return { checked: Object.hasOwn(marker.attributes, 'checked'), body };
}

class ArchiveTableProjection {
  readonly headings: MarkdownArchiveTableHeading[] = [];

  constructor(private readonly options: TableOptions) {}

  table(root: MarkdownArchiveHtmlNode, depth: number): RichContent {
    checkDepth(depth);
    if (root.tag !== 'table') return unsupported();
    const rows = elements(root.children).flatMap(child => child.tag === 'tr' ? [child]
      : child.tag === 'thead' || child.tag === 'tbody' || child.tag === 'tfoot' ? elements(child.children) : unsupported());
    if (!rows.length) unsupported();
    return { type: 'table', content: rows.map(row => {
      if (row.tag !== 'tr') return unsupported();
      return { type: 'tableRow', content: elements(row.children).map(cell => {
        if (cell.tag !== 'th' && cell.tag !== 'td') return unsupported();
        const type = cell.tag === 'th' ? 'tableHeader' : 'tableCell';
        const attrs = cellAttributes(cell);
        return { type, ...(attrs ? { attrs } : {}), content: this.flow(cell.children, depth + 3) };
      }) };
    }) };
  }

  private flow(parts: readonly HtmlPart[], depth: number): RichContent[] {
    checkDepth(depth);
    const blocks: RichContent[] = [];
    let inline: HtmlPart[] = [];
    let explicitId: string | undefined;
    const flush = () => {
      if (nonWhitespace(inline).length) blocks.push(this.inlineBlock(inline, depth + 1));
      inline = [];
    };
    for (const child of parts) {
      const marker = typeof child === 'string' ? undefined : explicitHeadingMarker(child);
      if (marker) {
        if (explicitId) unsupported();
        flush();
        explicitId = marker;
        continue;
      }
      if (typeof child !== 'string' && blockTags.has(child.tag)) {
        flush();
        if (explicitId && !headingTags.has(child.tag)) unsupported();
        if (child.tag === 'ul' || child.tag === 'ol') blocks.push(...this.list(child, depth + 1));
        else blocks.push(this.block(child, depth + 1, explicitId));
        explicitId = undefined;
      } else if (!whitespace(child) || inline.length) {
        if (explicitId) unsupported();
        inline.push(child);
      }
    }
    if (explicitId) unsupported();
    flush();
    return blocks.length ? blocks : [paragraph()];
  }

  private inlineBlock(parts: readonly HtmlPart[], depth: number): RichContent {
    const contents = nonWhitespace(parts);
    const first = contents[0];
    if (contents.length === 1 && typeof first !== 'string' && first?.tag === 'img') {
      const { src = '', alt = '', title } = first.attributes;
      const imageSrc = this.options.resolveImage?.(src);
      if (imageSrc) return { type: 'image', attrs: { src: imageSrc, alt, ...(title ? { title } : {}) } };
    }
    return paragraph(this.inline(parts, depth));
  }

  private inline(parts: readonly HtmlPart[], depth: number, marks: Mark[] = [], inLink = false): RichContent[] {
    checkDepth(depth);
    return parts.flatMap(child => {
      if (typeof child === 'string') return textNode(child.replace(/[\r\n\t]+/gu, ' '), marks);
      const { tag, children, attributes: attrs } = child;
      const wrapper = wrapperMarks.get(tag);
      if (wrapper) return this.inline(children, depth + 1, marks.some(mark => mark.type === wrapper) ? marks : [...marks, { type: wrapper }], inLink);
      switch (tag) {
        case 'a': {
          if (!attrs.href || inLink) return unsupported();
          const target = this.options.resolveLink?.(attrs.href);
          const styles = target?.href ? [...marks, { type: 'link', attrs: { href: target.href, ...(attrs.title ? { title: attrs.title } : {}) } }] : marks;
          const content = this.inline(children, depth + 1, styles, true);
          return [...(content.length ? content : textNode(target?.href ?? '링크', styles)),
            ...(target?.preservePath ? textNode(` (${attrs.href})`, marks) : [])];
        }
        case 'img': {
          this.options.warn?.('image');
          const target = attrs.src ? this.options.resolveLink?.(attrs.src) : undefined;
          const alt = attrs.alt?.replace(/\s+/gu, ' ').trim();
          const styles = target?.href && !inLink ? [...marks, { type: 'link', attrs: { href: target.href } }] : marks;
          return [...textNode(alt ? `${alt} (이미지)` : '이미지', styles),
            ...(target?.preservePath ? textNode(` (${attrs.src})`, marks) : [])];
        }
        case 'br': return [{ type: 'hardBreak' }];
        case 'code': {
          if (children.some(value => typeof value !== 'string')) return unsupported();
          const link = marks.find(mark => mark.type === 'link');
          return textNode(children.join(''), link ? [link] : [{ type: 'code' }]);
        }
        default: return unsupported();
      }
    });
  }

  private list(node: MarkdownArchiveHtmlNode, depth: number): RichContent[] {
    checkDepth(depth);
    const groups: RichContent[] = [];
    const ordered = node.tag === 'ol';
    const items = elements(node.children);
    if (!items.length) return unsupported();
    const rawStart = node.attributes.start;
    const start = rawStart === undefined ? 1 : Number(rawStart);
    if (!Number.isSafeInteger(start) || start < 0) return unsupported();
    const numberType = node.attributes.type;
    for (const [index, item] of items.entries()) {
      if (item.tag !== 'li') unsupported();
      const task = extractTask(item.children);
      if (task && ordered) this.options.warn?.('numberedTask');
      const type = task ? 'taskList' : ordered ? 'orderedList' : 'bulletList';
      let group = groups.at(-1);
      if (group?.type !== type) {
        group = { type, content: [], ...(type === 'orderedList' ? {
          attrs: { start: start + index, ...(numberType ? { type: numberType } : {}) },
        } : {}) };
        groups.push(group);
      }
      const content = this.flow(task?.body ?? item.children, depth + 1);
      if (content[0]?.type !== 'paragraph') content.unshift(paragraph());
      group.content!.push(task ? { type: 'taskItem', attrs: { checked: task.checked }, content } : { type: 'listItem', content });
    }
    return groups;
  }

  private block(node: MarkdownArchiveHtmlNode, depth: number, explicitId?: string): RichContent {
    checkDepth(depth);
    if (headingTags.has(node.tag)) {
      const level = Number(node.tag.slice(1));
      if (level > 3) this.options.warn?.('headingLevel');
      this.headings.push({ node, title: label(node.children, depth + 1).trim(), explicitId });
      const sectionId = this.options.sectionId?.(node);
      return { type: 'heading', attrs: { level: Math.min(3, level), ...(sectionId ? { sectionId } : {}) },
        content: this.inline(node.children, depth + 1) };
    }
    switch (node.tag) {
      case 'p': return this.inlineBlock(node.children, depth + 1);
      case 'blockquote': return { type: 'blockquote', content: this.flow(node.children, depth + 1) };
      case 'hr': return { type: 'horizontalRule' };
      case 'table': return this.table(node, depth + 1);
      case 'pre': {
        const [code, extra] = elements(node.children);
        if (extra || code?.tag !== 'code' || code.children.some(child => typeof child !== 'string')) return unsupported();
        const language = /^language-([\w+.-]{1,40})$/u.exec(code.attributes.class ?? '')?.[1];
        const codeText = code.children.join('').replace(/\n$/u, '');
        return { type: 'codeBlock', ...(language ? { attrs: { language } } : {}), content: textNode(codeText) };
      }
      case 'details': {
        const contents = nonWhitespace(node.children);
        const summary = contents[0];
        if (!summary || typeof summary === 'string' || summary.tag !== 'summary') return unsupported();
        return { type: 'details', content: [
          { type: 'detailsSummary', content: this.inline(summary.children, depth + 1) },
          { type: 'detailsContent', content: this.flow(contents.slice(1), depth + 1) },
        ] };
      }
      default: return unsupported();
    }
  }
}

export function projectMarkdownArchiveTable(root: MarkdownArchiveHtmlNode, options: TableOptions = {}) {
  const projection = new ArchiveTableProjection(options);
  try {
    return { content: projection.table(root, 0), headings: projection.headings };
  } catch (error) {
    if (error instanceof UnsupportedTableStructure) return undefined;
    throw error;
  }
}
