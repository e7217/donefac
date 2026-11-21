import { documentNodes } from './document-references.js';
import type { DocPage, RichContent } from './types.js';

export const MAX_DOCUMENT_CHILD_LISTS = 30;
export const MAX_DOCUMENT_CHILD_LIST_DEPTH = 60;
export const MAX_DOCUMENT_CHILD_LIST_FIRST = 500;
export const MAX_DOCUMENT_CHILD_LIST_ITEMS = 500;
export const MAX_DOCUMENT_CHILD_LIST_TITLE_LENGTH = 160;

export interface DocumentChildListOptions {
  scope: 'current' | 'document' | 'current-space' | 'space';
  documentId: string | null;
  projectId: string | null;
  depth: number | 'all';
  first: number | null;
  sort: 'title' | 'created' | 'updated';
  descending: boolean;
  style: 'list' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
  title: string;
}

export const DOCUMENT_CHILD_LIST_DEFAULTS: Readonly<DocumentChildListOptions> = {
  scope: 'current', documentId: null, projectId: null, depth: 1, first: null,
  sort: 'title', descending: false, style: 'list', title: '',
};

const childListStyles = new Set(['list', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const control = /[\u0000-\u001f\u007f-\u009f]/u;
const titleCollator = new Intl.Collator('ko', { sensitivity: 'base', numeric: true });

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 200 &&
    value.trim() === value && value.isWellFormed() && !control.test(value);
}

function boundedLimit(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max;
}

export function normalizeDocumentChildListOptions(raw: unknown): DocumentChildListOptions | null {
  if (raw !== undefined) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const prototype = Object.getPrototypeOf(raw);
    if ((prototype !== Object.prototype && prototype !== null) ||
      Object.keys(raw).some(key => !Object.hasOwn(DOCUMENT_CHILD_LIST_DEFAULTS, key))) return null;
  }
  const { scope, documentId, projectId, depth, first, sort, descending, style, title } = {
    ...DOCUMENT_CHILD_LIST_DEFAULTS, ...(raw as Partial<DocumentChildListOptions> | undefined),
  };
  if (scope !== 'current' && scope !== 'document' && scope !== 'current-space' && scope !== 'space') return null;
  if (scope === 'document' ? !isId(documentId) : documentId !== null) return null;
  if (scope === 'space' ? projectId !== null && !isId(projectId) : projectId !== null) return null;
  if ((depth !== 'all' && !boundedLimit(depth, MAX_DOCUMENT_CHILD_LIST_DEPTH)) ||
    (first !== null && !boundedLimit(first, MAX_DOCUMENT_CHILD_LIST_FIRST)) ||
    (sort !== 'title' && sort !== 'created' && sort !== 'updated') || typeof descending !== 'boolean' ||
    !childListStyles.has(style) || typeof title !== 'string' || !title.isWellFormed() || control.test(title)) return null;
  const normalizedTitle = title.trim().normalize('NFC');
  if (normalizedTitle.length > MAX_DOCUMENT_CHILD_LIST_TITLE_LENGTH) return null;
  return { scope, documentId, projectId, depth, first, sort, descending, style, title: normalizedTitle };
}

export function documentChildLists(content: RichContent): DocumentChildListOptions[] {
  const lists: DocumentChildListOptions[] = [];
  for (const node of documentNodes(content)) {
    if (node.type !== 'documentChildList') continue;
    const options = normalizeDocumentChildListOptions(node.attrs);
    if (options) lists.push(options);
  }
  return lists;
}

const sortLabels = { title: '제목', created: '작성일', updated: '수정일' };

export function documentChildListDescription(options: DocumentChildListOptions): string {
  const range = {
    current: '이 문서', document: `문서 ${options.documentId}`,
    'current-space': '이 문서의 공간', space: options.projectId ? `프로젝트 ${options.projectId}` : '팀 공통',
  }[options.scope];
  return [options.title, range, options.depth === 'all' ? '모든 하위 단계' : `${options.depth}단계`,
    `${sortLabels[options.sort]} ${options.descending ? '내림차순' : '오름차순'}`,
    options.first === null ? '' : `첫 단계 최대 ${options.first}개`,
    options.style === 'list' ? '' : `제목 ${options.style.slice(1)} 표시`].filter(Boolean).join(' · ');
}

type ChildRow = { document: DocPage; depth: number };

/** Projects only the active documents from the selected hierarchy and space. */
export function projectDocumentChildren(documents: readonly DocPage[], currentDocumentId: string | null,
  options: DocumentChildListOptions): { available: boolean; items: ChildRow[]; truncated: boolean } {
  const { scope, depth, first, sort, descending } = options;
  const items: ChildRow[] = [];
  const targetId = scope === 'document' ? options.documentId : currentDocumentId;
  const target = scope === 'space' ? undefined : documents.find(document => document.id === targetId);
  if (scope !== 'space' && !target) return { available: false, items, truncated: false };
  const projectId = scope === 'space' ? options.projectId : target!.projectId;
  const parentId = scope === 'current' || scope === 'document' ? targetId : null;

  const children = new Map<string | null, DocPage[]>();
  for (const document of documents) {
    if (document.projectId !== projectId) continue;
    const siblings = children.get(document.parentId) ?? [];
    siblings.push(document);
    children.set(document.parentId, siblings);
  }
  const dateKey = sort === 'created' ? 'createdAt' : 'updatedAt';
  const sorted = (id: string | null) => (children.get(id) ?? []).sort((a, b) => {
    const order = sort === 'title' ? titleCollator.compare(a.title, b.title) :
      (Date.parse(a[dateKey]) || 0) - (Date.parse(b[dateKey]) || 0);
    return order ? (descending ? -order : order) : a.id.localeCompare(b.id);
  });
  const firstLevel = sorted(parentId);
  const pending = (first === null ? firstLevel : firstLevel.slice(0, first)).map(document => ({ document, depth: 1 })).reverse();
  const visited = new Set(parentId === null ? [] : [parentId]);
  while (pending.length) {
    const row = pending.pop()!;
    if (visited.has(row.document.id)) continue;
    visited.add(row.document.id);
    if (items.length === MAX_DOCUMENT_CHILD_LIST_ITEMS) return { available: true, items, truncated: true };
    items.push(row);
    if (depth !== 'all' && row.depth >= depth) continue;
    const next = sorted(row.document.id);
    for (let index = next.length - 1; index >= 0; index--) pending.push({ document: next[index], depth: row.depth + 1 });
  }
  return { available: true, items, truncated: false };
}
