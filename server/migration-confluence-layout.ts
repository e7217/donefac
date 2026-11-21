import { MAX_DOCUMENT_COLUMNS, normalizeDocumentColumnLayoutOptions } from '../shared/document-nodes.js';
import type { ConfluenceStorageNode as XmlNode } from './migration-confluence-sections.js';

// https://confluence.atlassian.com/doc/confluence-storage-format-790796544.html#ConfluenceStorageFormat-Pagelayouts
const storageLayouts = new Map<string, readonly number[]>([
  ['single', [1]], ['two_equal', [1, 1]], ['two_left_sidebar', [3, 7]],
  ['two_right_sidebar', [7, 3]], ['three_equal', [1, 1, 1]], ['three_with_sidebars', [1, 3, 1]],
]);

const macroNames = new Set(['ac:structured-macro', 'ac:macro']);
const macroMetadata = ['ac:name', 'ac:schema-version', 'ac:macro-id', 'ac:local-id'];
// https://docs.atlassian.com/atlassian-confluence/5.7/constant-values.html
const namespaceDeclarations = new Map([
  ['xmlns:ac', 'http://atlassian.com/content'], ['xmlns:ri', 'http://atlassian.com/resource/identifier'],
]);

export type ConfluenceColumnRow = { columns: XmlNode[]; weights: readonly number[]; border: boolean };

function structuralChildren(node: XmlNode): XmlNode[] | null {
  const children = node.children.filter(child => typeof child !== 'string' || child.trim());
  return children.every(child => typeof child !== 'string') ? children : null;
}

function hasOnlyLayoutAttributes(node: XmlNode, extra: string[] = []): boolean {
  return Object.entries(node.attrs).every(([name, value]) => extra.includes(name) || namespaceDeclarations.get(name) === value);
}

function readLayout(node: XmlNode): ConfluenceColumnRow[] | null {
  const sections = structuralChildren(node);
  if (!hasOnlyLayoutAttributes(node) || !sections?.length) return null;
  const rows: ConfluenceColumnRow[] = [];
  for (const section of sections) {
    const weights = storageLayouts.get(section.attrs['ac:type']);
    const columns = structuralChildren(section);
    if (section.name !== 'ac:layout-section' || !hasOnlyLayoutAttributes(section, ['ac:type']) || !weights ||
        columns?.length !== weights.length || columns.some(cell => cell.name !== 'ac:layout-cell' || !hasOnlyLayoutAttributes(cell))) return null;
    rows.push({ columns, weights, border: false });
  }
  return rows;
}

// https://confluence.atlassian.com/conf711/page-layouts-columns-and-sections-1044781335.html
function readMacro(node: XmlNode, name: string, parameterName: string): { body: XmlNode; parameter?: string } | null {
  if (!macroNames.has(node.name) || node.attrs['ac:name'] !== name || !hasOnlyLayoutAttributes(node, macroMetadata)) return null;
  const parts = structuralChildren(node);
  if (!parts) return null;
  let body: XmlNode | undefined;
  let parameter: string | undefined;
  for (const child of parts) {
    if (child.name === 'ac:rich-text-body' && !body && hasOnlyLayoutAttributes(child)) body = child;
    else if (child.name === 'ac:parameter' && parameter === undefined && child.attrs['ac:name'] === parameterName &&
        hasOnlyLayoutAttributes(child, ['ac:name']) && child.children.every(part => typeof part === 'string')) {
      parameter = child.children.join('').trim();
    } else return null;
  }
  return body ? { body, parameter } : null;
}

function divisor(left: number, right: number): number {
  while (right) [left, right] = [right, left % right];
  return left;
}

function columnWeights(widths: (string | undefined)[]): number[] | null {
  if (widths.every(width => width === undefined)) return widths.map(() => 1);
  let unit: string | undefined;
  const sizes: number[] = [];
  for (const width of widths) {
    const match = /^(\d{1,6})(?:\.(\d{1,6}))?(%|px)$/u.exec(width ?? '');
    if (!match) return null;
    const [, whole, decimals = '', suffix] = match;
    if (unit && suffix !== unit) return null;
    unit = suffix;
    const size = Number(whole) * 1_000_000 + Number(decimals.padEnd(6, '0'));
    if (!size || suffix === '%' && size > 100_000_000) return null;
    sizes.push(size);
  }
  const common = sizes.reduce(divisor);
  return sizes.map(size => size / common);
}

function readSection(node: XmlNode): ConfluenceColumnRow[] | null {
  const section = readMacro(node, 'section', 'border');
  const border = section?.parameter?.toLowerCase();
  if (!section || border !== undefined && !['true', 'false'].includes(border)) return null;
  const cells = structuralChildren(section.body);
  if (!cells?.length || cells.length > MAX_DOCUMENT_COLUMNS) return null;
  const columns: XmlNode[] = [];
  const widths: (string | undefined)[] = [];
  for (const cell of cells) {
    const column = readMacro(cell, 'column', 'width');
    if (!column) return null;
    columns.push(column.body);
    widths.push(column.parameter);
  }
  const attrs = normalizeDocumentColumnLayoutOptions({ weights: columnWeights(widths), border: border === 'true' }, cells.length);
  return attrs ? [{ columns, ...attrs }] : null;
}

export function parseConfluenceColumnLayout(node: XmlNode, topLevel: boolean): ConfluenceColumnRow[] | null {
  return node.name === 'ac:layout' ? topLevel ? readLayout(node) : null : readSection(node);
}
