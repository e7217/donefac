import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { MarkdownArchiveHtmlNode } from '../shared/document-markdown-archive.js';
import { MAX_MARKDOWN_IMPORT_BYTES } from '../shared/document-markdown-import.js';
import { MAX_DOCUMENT_TABLE_SPAN } from '../shared/document-nodes.js';
import { isDocumentSectionId } from '../shared/document-sections.js';

const MAX_DEPTH = 50;
const MAX_NODES = 30_000;
// A small physical row can describe many slots when it contains spanning cells.
const MAX_TABLE_SLOTS = 30_000;
const groups = new Set(['thead', 'tbody', 'tfoot']);
const cells = new Set(['td', 'th']);
const voidTags = ['br', 'img', 'input', 'hr'];
const htmlTags = new Set([
  'table', ...groups, 'tr', ...cells,
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'b', 'em', 'i', 'del', 's', 'strike', 'u', 'code',
  'a', 'blockquote', 'ul', 'ol', 'li', 'pre', 'details', 'summary', ...voidTags,
]);
const cellAttributes = ['colspan', 'rowspan', 'align'];
const allowedAttributes: Readonly<Record<string, readonly string[]>> = {
  td: cellAttributes, th: cellAttributes,
  a: ['href', 'title', 'id', 'name'],
  img: ['src', 'alt', 'title'],
  ol: ['start', 'type'],
  input: ['type', 'checked', 'disabled'],
  code: ['class'],
  details: ['open'],
};
const booleanAttributes = new Set(['checked', 'disabled', 'open']);
const validation = { allowBooleanAttributes: true, unpairedTags: [...voidTags, ...voidTags.map(tag => tag.toUpperCase())] };
const parser = new XMLParser({
  ...validation, preserveOrder: true, ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false,
  processEntities: false, trimValues: false, maxNestedTags: MAX_DEPTH,
});
const namedEntities: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '©', reg: '®', trade: '™',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…',
};

function unsupported(): never {
  throw new Error('Unsupported Markdown table');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unsupported();
  return value as Record<string, unknown>;
}

function decodeEntities(value: string): string {
  return value.replace(/&(#(?:[xX][\da-fA-F]{1,6}|\d{1,7})|[A-Za-z][A-Za-z0-9]{0,30});|&/gu,
    (_match, name?: string) => {
      if (!name) return unsupported();
      if (name[0] !== '#') return Object.hasOwn(namedEntities, name) ? namedEntities[name] : unsupported();
      const point = /^#[xX]/u.test(name) ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      if ((point < 32 && point !== 9 && point !== 10 && point !== 13) || point === 0x7f || point > 0x10ffff ||
          (point >= 0xd800 && point <= 0xdfff) || point === 0xfffe || point === 0xffff) return unsupported();
      return String.fromCodePoint(point);
    });
}

function span(value: string | undefined): number {
  if (value === undefined) return 1;
  if (!/^\d{1,3}$/u.test(value)) return unsupported();
  const number = Number(value);
  return number >= 1 && number <= MAX_DOCUMENT_TABLE_SPAN ? number : unsupported();
}

function readAttributes(raw: unknown, tag: string): Record<string, string> {
  const attrs: Record<string, string> = Object.create(null);
  for (const [prefix, value] of Object.entries(raw === undefined ? {} : record(raw))) {
    const name = prefix.slice(2).toLowerCase();
    if (!prefix.startsWith('@_') || !allowedAttributes[tag]?.includes(name) || Object.hasOwn(attrs, name)) return unsupported();
    if (booleanAttributes.has(name)) {
      if (value !== true && typeof value !== 'string') return unsupported();
      attrs[name] = '';
    } else {
      if (typeof value !== 'string') return unsupported();
      attrs[name] = decodeEntities(value);
    }
  }
  if (cells.has(tag)) {
    for (const key of ['colspan', 'rowspan']) if (attrs[key] !== undefined) attrs[key] = String(span(attrs[key]));
    if (attrs.align !== undefined && !['left', 'center', 'right'].includes(attrs.align.toLowerCase())) return unsupported();
    if (attrs.align !== undefined) attrs.align = attrs.align.toLowerCase();
  }
  if (tag === 'a') {
    const anchors = [attrs.id, attrs.name].filter(value => value !== undefined);
    if (attrs.href === undefined ? !anchors.length || anchors.some(value => value !== anchors[0] || !isDocumentSectionId(value)) : anchors.length > 0) {
      return unsupported();
    }
  }
  if (tag === 'img' && !attrs.src) return unsupported();
  if (tag === 'input' && attrs.type?.toLowerCase() !== 'checkbox') return unsupported();
  if (tag === 'input') attrs.type = 'checkbox';
  if (tag === 'ol' && ((attrs.start !== undefined && !/^\d{1,9}$/u.test(attrs.start)) ||
      (attrs.type !== undefined && !/^[1aAiI]$/u.test(attrs.type)))) return unsupported();
  if (tag === 'code' && attrs.class !== undefined && !/^language-[\w+.-]{1,40}$/u.test(attrs.class)) return unsupported();
  return attrs;
}

function htmlTree(parsed: unknown): MarkdownArchiveHtmlNode {
  let nodes = 0;
  function read(value: unknown, depth: number): MarkdownArchiveHtmlNode | string {
    if (depth > MAX_DEPTH || ++nodes > MAX_NODES) return unsupported();
    const entry = record(value);
    const keys = Object.keys(entry).filter(key => key !== ':@');
    const name = keys[0];
    if (keys.length !== 1) return unsupported();
    const raw = entry[name];
    if (name === '#text') return typeof raw === 'string' ? decodeEntities(raw) : unsupported();
    const tag = name.toLowerCase();
    if (!htmlTags.has(tag) || !Array.isArray(raw)) return unsupported();
    const attributes = readAttributes(entry[':@'], tag);
    const children = raw.map(child => read(child, depth + 1));
    if (voidTags.includes(tag) && children.length > 0) return unsupported();
    return { tag, attributes, children };
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) return unsupported();
  const root = read(parsed[0], 0);
  if (typeof root === 'string' || root.tag !== 'table') return unsupported();
  return root;
}

function elementChildren(node: MarkdownArchiveHtmlNode): MarkdownArchiveHtmlNode[] {
  return node.children.flatMap(child => {
    if (typeof child !== 'string') return [child];
    if (!/^[\t\n\r ]*$/u.test(child)) return unsupported();
    return [];
  });
}

function checkTable(table: MarkdownArchiveHtmlNode): void {
  const rows: MarkdownArchiveHtmlNode[] = [];
  const groupEnds: number[] = [];
  const pendingRows: MarkdownArchiveHtmlNode[] = [];
  function append(group: MarkdownArchiveHtmlNode[]) {
    const end = rows.length + group.length;
    for (const row of group) {
      if (row.tag !== 'tr') return unsupported();
      rows.push(row);
      groupEnds.push(end);
    }
  }
  const children = elementChildren(table);
  let body: 'tr' | 'tbody' | undefined;
  for (const [index, child] of children.entries()) {
    // The projector retains source order. Accept the HTML table order and a single body form.
    if (child.tag === 'thead' && index === 0) append(elementChildren(child));
    else if (child.tag === 'tr' && body !== 'tbody') {
      body = 'tr';
      pendingRows.push(child);
    } else if (child.tag === 'tbody' && body !== 'tr') {
      body = 'tbody';
      append(elementChildren(child));
    } else if (child.tag === 'tfoot' && index === children.length - 1) {
      append(pendingRows);
      pendingRows.length = 0;
      append(elementChildren(child));
    } else return unsupported();
  }
  append(pendingRows);
  if (!rows.length) return unsupported();
  const occupancy: number[] = [];
  let width = 0;
  for (const [index, row] of rows.entries()) {
    let column = 0;
    for (const cell of elementChildren(row)) {
      if (!cells.has(cell.tag)) return unsupported();
      while (occupancy[column] > index) column++;
      const nextColumn = column + span(cell.attributes.colspan);
      const end = index + span(cell.attributes.rowspan);
      if (end > groupEnds[index] || (index > 0 && nextColumn > width) || nextColumn * rows.length > MAX_TABLE_SLOTS) {
        return unsupported();
      }
      for (; column < nextColumn; column++) {
        if (occupancy[column] > index) return unsupported();
        occupancy[column] = end;
      }
    }
    if (index === 0) width = column;
    if (!width) return unsupported();
    for (let slot = 0; slot < width; slot++) if (!(occupancy[slot] > index)) return unsupported();
  }
}

function checkShape(node: MarkdownArchiveHtmlNode, parent?: string): void {
  const { tag, children } = node;
  if (tag === 'table') checkTable(node);
  if ((groups.has(tag) && parent !== 'table') ||
      (tag === 'tr' && parent !== 'table' && !groups.has(parent ?? '')) ||
      (cells.has(tag) && parent !== 'tr') ||
      (tag === 'li' && parent !== 'ul' && parent !== 'ol') ||
      (tag === 'summary' && parent !== 'details')) return unsupported();
  if (tag === 'ul' || tag === 'ol') {
    const items = elementChildren(node);
    if (!items.length || items.some(item => item.tag !== 'li')) return unsupported();
  }
  if (tag === 'pre') {
    const code = elementChildren(node);
    if (code.length !== 1 || code[0].tag !== 'code') return unsupported();
  }
  if (tag === 'code' && children.some(child => typeof child !== 'string')) return unsupported();
  if (tag === 'details') {
    const blocks = children.filter(child => typeof child !== 'string' || !/^[\t\n\r ]*$/u.test(child));
    if (typeof blocks[0] === 'string' || blocks[0]?.tag !== 'summary' ||
        blocks.slice(1).some(child => typeof child !== 'string' && child.tag === 'summary')) return unsupported();
  }
  for (const child of children) if (typeof child !== 'string') checkShape(child, tag);
}

export function parseMarkdownArchiveTable(raw: string): MarkdownArchiveHtmlNode | undefined {
  if (!/^\s*<table(?=[\s>])/iu.test(raw) || /<[!?]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(raw) ||
      !raw.isWellFormed() || Buffer.byteLength(raw) > MAX_MARKDOWN_IMPORT_BYTES) return undefined;
  try {
    if (XMLValidator.validate(raw, validation) !== true) return undefined;
    const root = htmlTree(parser.parse(raw));
    checkShape(root);
    return root;
  } catch {
    // Unsupported HTML is preserved as literal Markdown by the caller.
    return undefined;
  }
}
