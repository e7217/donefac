import { normalizeDocumentLabels } from './document-labels.js';
import { documentNodes } from './document-references.js';
import type { RichContent } from './types.js';

export const MAX_DOCUMENT_LABEL_LIST_LIMIT = 500;
export const MAX_DOCUMENT_LABEL_LISTS = 30;
export const MAX_DOCUMENT_LABEL_LIST_TITLE_LENGTH = 160;

export interface DocumentLabelListOptions {
  projectId: string | null;
  labels: string[];
  match: 'any' | 'all';
  sort: 'title' | 'created' | 'updated';
  descending: boolean;
  limit: number;
  title: string;
  showLabels: boolean;
  showSpace: boolean;
  excludeCurrent: boolean;
}

export const DOCUMENT_LABEL_LIST_DEFAULTS: Readonly<DocumentLabelListOptions> = {
  projectId: null, labels: [], match: 'any', sort: 'updated', descending: true, limit: 15,
  title: '', showLabels: true, showSpace: false, excludeCurrent: true,
};

export function normalizeDocumentLabelListOptions(raw: unknown): DocumentLabelListOptions | null {
  if (raw !== undefined) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const prototype = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (Object.keys(raw).some(key => !Object.hasOwn(DOCUMENT_LABEL_LIST_DEFAULTS, key))) return null;
  }
  const source = { ...DOCUMENT_LABEL_LIST_DEFAULTS, ...(raw as Record<string, unknown> | undefined) };
  const { projectId, match, sort, descending, limit, title, showLabels, showSpace, excludeCurrent } = source;
  if (projectId !== null && (typeof projectId !== 'string' || !projectId.trim() || projectId !== projectId.trim() ||
    projectId.length > 200 || !projectId.isWellFormed() || /[\u0000-\u001f\u007f-\u009f]/u.test(projectId))) return null;
  const labels = normalizeDocumentLabels(source.labels);
  if (!labels || (match !== 'any' && match !== 'all') || (sort !== 'title' && sort !== 'created' && sort !== 'updated') ||
    typeof descending !== 'boolean' || typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_DOCUMENT_LABEL_LIST_LIMIT ||
    typeof title !== 'string' || !title.isWellFormed() || /[\u0000-\u001f\u007f-\u009f]/u.test(title) ||
    typeof showLabels !== 'boolean' || typeof showSpace !== 'boolean' || typeof excludeCurrent !== 'boolean') return null;
  const normalizedTitle = title.trim().normalize('NFC');
  if (normalizedTitle.length > MAX_DOCUMENT_LABEL_LIST_TITLE_LENGTH) return null;
  return { projectId, labels, match, sort, descending, limit, title: normalizedTitle, showLabels, showSpace, excludeCurrent };
}

export function documentLabelLists(content: RichContent): DocumentLabelListOptions[] {
  const lists: DocumentLabelListOptions[] = [];
  for (const node of documentNodes(content)) {
    if (node.type !== 'documentLabelList') continue;
    const options = normalizeDocumentLabelListOptions(node.attrs);
    if (options) lists.push(options);
  }
  return lists;
}

const SORT_LABELS: Record<DocumentLabelListOptions['sort'], string> = { title: '제목', created: '작성일', updated: '수정일' };

export function documentLabelListDescription(options: DocumentLabelListOptions): string {
  const labels = options.labels.length ? `${options.match === 'all' ? '모든 라벨' : '선택 라벨 중 하나'} ${options.labels.join(', ')}` : '선택한 라벨 없음';
  return [options.title, labels, options.projectId === null ? '팀 공통' : `프로젝트 ${options.projectId}`,
    `${SORT_LABELS[options.sort]} ${options.descending ? '내림차순' : '오름차순'}`, `최대 ${options.limit}개`].filter(Boolean).join(' · ');
}
