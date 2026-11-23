import { isCalendarDate } from '../shared/calendar.js';
import { normalizeDocumentLabels } from '../shared/document-labels.js';
import {
  MAX_DOCUMENT_PROPERTY_ENTRIES, MAX_DOCUMENT_PROPERTY_NAME_LENGTH, MAX_DOCUMENT_PROPERTY_REPORT_LIMIT,
  normalizeDocumentPropertiesOptions, normalizeDocumentPropertyReportOptions,
  type DocumentPropertiesOptions, type DocumentPropertyReportOptions,
} from '../shared/document-properties.js';
import { parseConfluencePageLabelScope } from './migration-confluence-label-list.js';
import type { ConfluenceStorageNode as XmlNode } from './migration-confluence-sections.js';

// https://confluence.atlassian.com/spaces/CONF52/pages/401441890/Confluence+Storage+Format+for+Macros
// https://confluence.atlassian.com/conf712/page-properties-macro-1056671754.html
// https://confluence.atlassian.com/conf720/page-properties-report-macro-1168861513.html
export const confluencePropertyReportMacros = new Set(['detailssummary', 'page-properties-report']);

export function hasConfluencePropertyMacro(source: string) {
  return /<ac:(?:structured-macro|macro)\s[^<>]*\bac:name\s*=\s*(?:"(?:details|detailssummary|page-properties-report)"|'(?:details|detailssummary|page-properties-report)')/u.test(source);
}

export function hasConfluencePropertyReportMacro(source: string) {
  return /<ac:(?:structured-macro|macro)\s[^<>]*\bac:name\s*=\s*(?:"(?:detailssummary|page-properties-report)"|'(?:detailssummary|page-properties-report)')/u.test(source);
}

function elements(node: XmlNode): XmlNode[] | null {
  const result: XmlNode[] = [];
  for (const part of node.children) {
    if (typeof part !== 'string') result.push(part);
    else if (part.trim()) return null;
  }
  return result;
}

const tableClasses = new Set(['wrapped', 'confluenceTable']);

function cellAttributes(cell: XmlNode) {
  return Object.entries(cell.attrs).every(([name, value]) =>
    (name === 'colspan' || name === 'rowspan') && value === '1' ||
    name === 'class' && value === (cell.name === 'th' ? 'confluenceTh' : 'confluenceTd') ||
    name === 'style' && /^\s*text-align:\s*left\s*;?\s*$/u.test(value));
}

function tableCells(table: XmlNode): XmlNode[][] | null {
  if (Object.entries(table.attrs).some(([key, value]) => key !== 'class' || !value.trim() ||
    !value.trim().split(/\s+/u).every(name => tableClasses.has(name)))) return null;
  const groups = elements(table);
  if (!groups?.length) return null;
  const rows: XmlNode[][] = [];
  let columnCount: number | undefined;
  function readRows(items: XmlNode[], header = false) {
    for (const row of items) {
      if (row.name !== 'tr' || Object.keys(row.attrs).length) return false;
      const cells = elements(row);
      if (!cells?.length || cells.length > MAX_DOCUMENT_PROPERTY_ENTRIES || columnCount !== undefined && cells.length !== columnCount ||
        cells.some(cell => !['th', 'td'].includes(cell.name) || !cellAttributes(cell) || header && cell.name !== 'th')) return false;
      rows.push(cells);
      if (rows.length > MAX_DOCUMENT_PROPERTY_ENTRIES) return false;
    }
    return true;
  }
  for (const group of groups) {
    if (group.name === 'colgroup' && !rows.length && columnCount === undefined && !Object.keys(group.attrs).length) {
      const columns = elements(group);
      if (!columns?.length || columns.length > MAX_DOCUMENT_PROPERTY_ENTRIES ||
        columns.some(col => col.name !== 'col' || Object.keys(col.attrs).length || elements(col)?.length !== 0)) return null;
      columnCount = columns.length;
    } else if (group.name === 'tr') {
      if (!readRows([group])) return null;
    } else if (['thead', 'tbody'].includes(group.name) && !Object.keys(group.attrs).length) {
      const children = elements(group);
      if (!children?.length || !readRows(children, group.name === 'thead')) return null;
    } else return null;
  }
  return rows.length ? rows : null;
}

function propertyPairs(rows: XmlNode[][]): [XmlNode, XmlNode][] | null {
  const [headers, values] = rows;
  if (rows.length === 2 && headers.length === values.length &&
    headers.every(cell => cell.name === 'th') && values.every(cell => cell.name === 'td')) {
    return headers.map((header, index) => [header, values[index]]);
  }
  // Older storage uses ordinary cells for both columns. Recent versions mark the first column as headings.
  const firstColumn = headers[0].name;
  return rows.every(row => row.length === 2 && row[0].name === firstColumn && row[1].name === 'td')
    ? rows.map(([header, value]) => [header, value]) : null;
}

function statusText(node: XmlNode) {
  if (Object.keys(node.attrs).some(key => !['ac:name', 'ac:schema-version', 'ac:macro-id', 'ac:local-id', 'xmlns:ac', 'xmlns:ri'].includes(key))) return null;
  const children = elements(node);
  if (!children) return null;
  const params = new Map<string, string>();
  for (const parameter of children) {
    const key = parameter.attrs['ac:name'];
    if (parameter.name !== 'ac:parameter' || Object.keys(parameter.attrs).length !== 1 ||
      !['title', 'colour', 'subtle'].includes(key) || params.has(key) || parameter.children.some(part => typeof part !== 'string')) return null;
    params.set(key, parameter.children.join('').trim());
  }
  const color = (params.get('colour') || 'grey').toLowerCase();
  if (!['neutral', 'grey', 'gray', 'red', 'green', 'blue', 'yellow', 'purple'].includes(color) ||
    parseFlag(params.get('subtle'), false) === null) return null;
  return params.get('title') || null;
}

type CellText = { text: string; status?: true };

function propertyCellText(cell: XmlNode, forValue: boolean): CellText | null {
  const content = cell.children.filter(part => typeof part !== 'string' || part.trim());
  const [first] = content;
  if (content.length === 1 && typeof first !== 'string' && first.name === 'p' && !Object.keys(first.attrs).length) {
    return propertyCellText(first, forValue);
  }
  if (content.length === 1 && typeof first !== 'string' && first.name === 'br' && !Object.keys(first.attrs).length &&
    elements(first)?.length === 0) return { text: '' };
  if (forValue && content.length === 1 && typeof first !== 'string') {
    if (first.name === 'time' && Object.keys(first.attrs).length === 1 && isCalendarDate(first.attrs.datetime) && elements(first)?.length === 0) {
      return { text: first.attrs.datetime };
    }
    if (['ac:structured-macro', 'ac:macro'].includes(first.name) && first.attrs['ac:name'] === 'status') {
      const status = statusText(first);
      return status ? { text: status, status: true } : null;
    }
  }
  if (cell.children.every(part => typeof part === 'string')) return { text: cell.children.join('').replace(/[\t\r\n ]+/gu, ' ').trim() };
  return null;
}

type PropertiesProjection = { options: DocumentPropertiesOptions; containsStatus: boolean } | { reason: 'parameters' | 'table' | 'values' };

export function parseConfluenceDocumentProperties(params: Record<string, string>, body?: XmlNode): PropertiesProjection {
  const hidden = parseFlag(params.hidden, false);
  if (hidden === null || Object.keys(params).some(key => !['hidden', 'id'].includes(key))) return { reason: 'parameters' };
  const content = body && elements(body);
  if (content?.length !== 1 || content[0].name !== 'table') return { reason: 'table' };
  const rows = tableCells(content[0]);
  const pairs = rows && propertyPairs(rows);
  if (!pairs) return { reason: 'table' };
  const entries: DocumentPropertiesOptions['entries'] = [];
  let containsStatus = false;
  for (const [header, cell] of pairs) {
    const name = propertyCellText(header, false), value = propertyCellText(cell, true);
    if (!name?.text || value === null) return { reason: 'values' };
    if (value.status) containsStatus = true;
    entries.push({ name: name.text, value: value.text });
  }
  const options = normalizeDocumentPropertiesOptions({ group: params.id ?? '', hidden, entries });
  return options ? { options, containsStatus } : { reason: 'values' };
}

function parseFlag(value: string | undefined, fallback: boolean) {
  const normalized = value?.trim().toLowerCase();
  return !normalized ? fallback : normalized === 'true' ? true : normalized === 'false' ? false : null;
}

const labelPattern = /^[\p{L}\p{N}_][\p{L}\p{N}_-]*$/u;
const spacePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u;

function reportScope(params: Record<string, string>) {
  if (Object.hasOwn(params, 'cql')) {
    if (['label', 'space', 'spaces'].some(key => Object.hasOwn(params, key))) return null;
    return parseConfluencePageLabelScope(params.cql.trim());
  }
  if (!params.label || !labelPattern.test(params.label.trim()) || Object.hasOwn(params, 'space') && Object.hasOwn(params, 'spaces')) return null;
  const rawSpace = (params.space ?? params.spaces ?? '').trim();
  const spaceKey = !rawSpace || rawSpace === '@self' ? null : rawSpace;
  const labels = normalizeDocumentLabels([params.label]);
  return labels && (spaceKey === null || spacePattern.test(spaceKey)) ? { spaceKey, labels, match: 'all' as const, order: undefined } : null;
}

function reportColumns(raw: string | undefined): string[] | null {
  const source = raw?.trim();
  if (!source) return [];
  if (source.length > MAX_DOCUMENT_PROPERTY_ENTRIES * (2 * MAX_DOCUMENT_PROPERTY_NAME_LENGTH + 4)) return null;
  const columns: string[] = [];
  const field = /[ \t]*(?:"((?:[^"]|"")*)"|([^",]*?))[ \t]*(,|$)/gyu;
  while (field.lastIndex < source.length) {
    const part = field.exec(source);
    if (!part || !part[0].length) return null;
    const column = (part[1]?.replaceAll('""', '"') ?? part[2]).trim();
    if (!column || columns.length >= MAX_DOCUMENT_PROPERTY_ENTRIES || part[3] === ',' && field.lastIndex === source.length) return null;
    columns.push(column);
  }
  return columns;
}

const reportParameters = new Set(['label', 'space', 'spaces', 'cql', 'id', 'firstcolumn', 'headings', 'pageSize',
  'sortBy', 'reverseSort', 'countComments', 'countLikes']);

export function parseConfluenceDocumentPropertyReport(params: Record<string, string>): { spaceKey: string | null; options: DocumentPropertyReportOptions } | null {
  if (Object.keys(params).some(key => !reportParameters.has(key)) || !['', 'Title'].includes(params.firstcolumn?.trim() ?? '') ||
    parseFlag(params.countComments, false) !== false || parseFlag(params.countLikes, false) !== false) return null;
  const pageSize = params.pageSize?.trim();
  if (pageSize && (!/^[1-9]\d{0,2}$/u.test(pageSize) || Number(pageSize) > MAX_DOCUMENT_PROPERTY_REPORT_LIMIT)) return null;
  const scope = reportScope(params), columns = reportColumns(params.headings), reverse = parseFlag(params.reverseSort, false);
  if (!scope || !columns || reverse === null) return null;
  const sourceSort = params.sortBy?.trim().toLowerCase() ?? '';
  const sort = sourceSort === 'title' ? 'title' : ['', 'modified', 'lastmodified', 'last modified', 'last modified date'].includes(sourceSort) ? 'updated' : null;
  if (!sort) return null;
  const descending = (sort === 'updated') !== reverse;
  if (scope.order && (scope.order.sort === 'created' ||
    (Boolean(sourceSort) || Object.hasOwn(params, 'reverseSort')) && (scope.order.sort !== sort || scope.order.descending !== descending))) return null;
  const normalized = normalizeDocumentPropertyReportOptions({ group: params.id ?? '', labels: scope.labels, match: scope.match, columns,
    sort: scope.order?.sort ?? sort, descending: scope.order?.descending ?? descending, limit: MAX_DOCUMENT_PROPERTY_REPORT_LIMIT });
  return normalized ? { spaceKey: scope.spaceKey, options: normalized } : null;
}
