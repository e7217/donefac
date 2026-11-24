import { documentLabelKey, normalizeDocumentLabels } from './document-labels.js';
import { documentNodes } from './document-references.js';
import type { DocPage, RichContent } from './types.js';

export const MAX_DOCUMENT_PROPERTY_BLOCKS = 30;
export const MAX_DOCUMENT_PROPERTY_ENTRIES = 24;
export const MAX_DOCUMENT_PROPERTY_NAME_LENGTH = 80;
export const MAX_DOCUMENT_PROPERTY_VALUE_LENGTH = 800;
export const MAX_DOCUMENT_PROPERTY_GROUP_LENGTH = 80;
export const MAX_DOCUMENT_PROPERTY_REPORT_LIMIT = 200;
export const MAX_DOCUMENT_PROPERTY_REPORT_TITLE_LENGTH = 160;
export const MAX_DOCUMENT_PROPERTY_REPORT_SPACES = 50;

export interface DocumentPropertiesOptions {
  group: string;
  hidden: boolean;
  entries: { name: string; value: string }[];
}

export interface DocumentPropertyReportOptions {
  projectId: string | null;
  projectIds?: (string | null)[] | null;
  group: string;
  labels: string[];
  match: 'any' | 'all';
  columns: string[];
  sort: 'title' | 'updated';
  descending: boolean;
  limit: number;
  title: string;
}

export const DOCUMENT_PROPERTIES_DEFAULTS: Readonly<DocumentPropertiesOptions> = { group: '', hidden: false, entries: [] };
export const DOCUMENT_PROPERTY_REPORT_DEFAULTS: Readonly<DocumentPropertyReportOptions> = {
  projectId: null, projectIds: null, group: '', labels: [], match: 'all', columns: [], sort: 'updated', descending: true, limit: 30, title: '',
};

function hasOnlyAttributes(raw: unknown, keys: object): raw is Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const prototype = Object.getPrototypeOf(raw);
  return (prototype === Object.prototype || prototype === null) && Object.keys(raw).every(key => Object.hasOwn(keys, key));
}

const singleLineControls = /[\u0000-\u001f\u007f-\u009f]/u;
const multilineControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

function displayName(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string' || !value.isWellFormed() || singleLineControls.test(value)) return null;
  const normalized = value.trim().normalize('NFC');
  return normalized.length <= maxLength ? normalized : null;
}

function propertyValue(value: unknown): string | null {
  if (typeof value !== 'string' || !value.isWellFormed() || multilineControls.test(value)) return null;
  const normalized = value.replace(/\r\n?/gu, '\n').normalize('NFC');
  return normalized.length <= MAX_DOCUMENT_PROPERTY_VALUE_LENGTH ? normalized : null;
}

export function normalizeDocumentPropertiesOptions(raw: unknown): DocumentPropertiesOptions | null {
  if (raw !== undefined && !hasOnlyAttributes(raw, DOCUMENT_PROPERTIES_DEFAULTS)) return null;
  const source = { ...DOCUMENT_PROPERTIES_DEFAULTS, ...(raw as Record<string, unknown> | undefined) };
  const group = displayName(source.group, MAX_DOCUMENT_PROPERTY_GROUP_LENGTH);
  if (group === null || typeof source.hidden !== 'boolean' || !Array.isArray(source.entries) ||
      source.entries.length > MAX_DOCUMENT_PROPERTY_ENTRIES) return null;

  const seen = new Set<string>();
  const entries: DocumentPropertiesOptions['entries'] = [];
  for (const entry of source.entries) {
    if (!hasOnlyAttributes(entry, { name: '', value: '' })) return null;
    const name = displayName(entry.name, MAX_DOCUMENT_PROPERTY_NAME_LENGTH);
    const value = propertyValue(entry.value);
    if (!name || value === null || seen.has(name)) return null;
    seen.add(name);
    entries.push({ name, value });
  }
  return { group, hidden: source.hidden, entries };
}

function isReportProjectId(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && !!value && value === value.trim() &&
    value.isWellFormed() && value.length <= 200 && !singleLineControls.test(value));
}

export function normalizeDocumentPropertyReportOptions(raw: unknown): DocumentPropertyReportOptions | null {
  if (raw !== undefined && !hasOnlyAttributes(raw, DOCUMENT_PROPERTY_REPORT_DEFAULTS)) return null;
  const source = { ...DOCUMENT_PROPERTY_REPORT_DEFAULTS, ...(raw as Record<string, unknown> | undefined) };
  const { projectId, projectIds, match, sort, descending, limit } = source;
  const group = displayName(source.group, MAX_DOCUMENT_PROPERTY_GROUP_LENGTH);
  const title = displayName(source.title, MAX_DOCUMENT_PROPERTY_REPORT_TITLE_LENGTH);
  const labels = normalizeDocumentLabels(source.labels);
  if (!isReportProjectId(projectId) || group === null || title === null || !labels || (match !== 'any' && match !== 'all') ||
      (sort !== 'title' && sort !== 'updated') || typeof descending !== 'boolean' ||
      typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_DOCUMENT_PROPERTY_REPORT_LIMIT ||
      !Array.isArray(source.columns) || source.columns.length > MAX_DOCUMENT_PROPERTY_ENTRIES) return null;

  const selected = new Set<string | null>();
  if (projectIds !== null && projectIds !== undefined) {
    if (projectId !== null || !Array.isArray(projectIds) || projectIds.length < 2 || projectIds.length > MAX_DOCUMENT_PROPERTY_REPORT_SPACES) return null;
    for (const id of projectIds) {
      if (!isReportProjectId(id) || selected.has(id)) return null;
      selected.add(id);
    }
  }
  const columns = new Set<string>();
  for (const column of source.columns) {
    const name = displayName(column, MAX_DOCUMENT_PROPERTY_NAME_LENGTH);
    if (!name || columns.has(name)) return null;
    columns.add(name);
  }
  return { projectId, ...(selected.size ? { projectIds: [...selected] } : {}), group, labels, match, columns: [...columns], sort, descending, limit, title };
}

export function documentPropertyReportProjectIds(options: DocumentPropertyReportOptions): readonly (string | null)[] {
  return options.projectIds ?? [options.projectId];
}

export function documentPropertyReports(content: RichContent): DocumentPropertyReportOptions[] {
  const reports: DocumentPropertyReportOptions[] = [];
  for (const node of documentNodes(content)) {
    if (node.type !== 'documentPropertyReport') continue;
    const options = normalizeDocumentPropertyReportOptions(node.attrs);
    if (options) reports.push(options);
  }
  return reports;
}

export function documentPropertyReportDescription(options: DocumentPropertyReportOptions): string {
  const labels = options.labels.length ? `${options.match === 'all' ? '모든 라벨' : '선택 라벨 중 하나'} ${options.labels.join(', ')}` : '라벨 미지정';
  const selected = documentPropertyReportProjectIds(options).map(id => id === null ? '팀 공통' : `프로젝트 ${id}`);
  const scope = selected.length === 1 ? selected[0] : `문서 공간 ${selected.length}곳 (${selected.join(', ')})`;
  return [options.title, scope, labels,
    options.group ? `속성 그룹 ${options.group}` : '모든 속성 그룹', options.columns.length ? options.columns.join(', ') : '자동 열',
    `${options.sort === 'title' ? '제목' : '수정일'} ${options.descending ? '내림차순' : '오름차순'}`, `최대 ${options.limit}행`]
    .filter(Boolean).join(' · ');
}

interface DocumentPropertyReportRow {
  id: string;
  document: DocPage;
  group: string;
  entries: Record<string, string>;
}

const compareTitle = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });

/** The caller supplies the active workspace snapshots, never revision contents or included projections. */
export function collectDocumentPropertyReport(documents: readonly DocPage[], options: DocumentPropertyReportOptions) {
  const rows: DocumentPropertyReportRow[] = [];
  const columns = new Set(options.columns);
  let total = 0;
  if (!options.labels.length) return { columns: [...columns], rows, total };

  const selected = new Set(documentPropertyReportProjectIds(options));
  const labels = options.labels.map(documentLabelKey);
  const matchingDocuments = documents.filter(document => {
    if (!selected.has(document.projectId)) return false;
    const available = new Set((document.labels ?? []).map(documentLabelKey));
    return options.match === 'all' ? labels.every(label => available.has(label)) : labels.some(label => available.has(label));
  }).sort((a, b) => {
    const order = options.sort === 'title' ? compareTitle.compare(a.title, b.title) : a.updatedAt.localeCompare(b.updatedAt);
    return (options.descending ? -order : order) || a.id.localeCompare(b.id);
  });

  for (const document of matchingDocuments) {
    let blockIndex = 0;
    for (const node of documentNodes(document.content)) {
      if (node.type !== 'documentProperties') continue;
      blockIndex++;
      const properties = normalizeDocumentPropertiesOptions(node.attrs);
      if (!properties?.entries.length || (options.group && properties.group !== options.group)) continue;
      total++;
      if (rows.length >= options.limit) continue;
      const entries = Object.create(null) as Record<string, string>;
      for (const { name, value } of properties.entries) {
        entries[name] = value;
        if (!options.columns.length && columns.size < MAX_DOCUMENT_PROPERTY_ENTRIES) columns.add(name);
      }
      rows.push({ id: JSON.stringify([document.id, blockIndex]), document, group: properties.group, entries });
    }
  }
  return { columns: [...columns], rows, total };
}
