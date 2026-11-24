import type { DocumentPublicationListTab, DocumentPublicationScope } from './types.js';

export const DOCUMENT_PUBLICATION_PAGE_SIZE = 30;
export const DOCUMENT_PUBLICATION_QUERY_LIMIT = 200;
export const DOCUMENT_PUBLICATION_MAX_OFFSET = 1_000_000;

export type DocumentPublicationCriteria = {
  scope: DocumentPublicationScope;
  projectId: string;
  query: string;
  offset: number;
};

export type DocumentPublicationReturnTarget = {
  documentId: string;
  kind: 'review' | 'published';
  revisionId: string;
};

const controlCharacters = /[\u0000-\u001f\u007f]/g;

export function defaultDocumentPublicationCriteria(tab: DocumentPublicationListTab, projectId: string): DocumentPublicationCriteria {
  return { scope: tab === 'published' && projectId ? 'project' : 'workspace', projectId, query: '', offset: 0 };
}

export function normalizeDocumentPublicationQuery(value: string): string {
  return value.toWellFormed().replace(controlCharacters, '').trim().normalize('NFC')
    .slice(0, DOCUMENT_PUBLICATION_QUERY_LIMIT).replace(/[\ud800-\udbff]$/u, '').trimEnd();
}

function validProjectId(value: string | null): value is string {
  return Boolean(value && value.length <= 200 && value.trim() && !/[\u0000-\u001f\u007f]/u.test(value));
}

function pageOffset(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 && value <= DOCUMENT_PUBLICATION_MAX_OFFSET
    ? value - value % DOCUMENT_PUBLICATION_PAGE_SIZE : 0;
}

export function readDocumentPublicationCriteria(params: URLSearchParams, tab: DocumentPublicationListTab, projectId: string): DocumentPublicationCriteria {
  const defaults = defaultDocumentPublicationCriteria(tab, projectId);
  const requestedScope = params.get('scope');
  const requestedProject = params.get('projectId');
  const selectedProject = validProjectId(requestedProject) ? requestedProject : projectId;
  const scope = requestedScope === 'common' || requestedScope === 'workspace' || (requestedScope === 'project' && selectedProject)
    ? requestedScope : defaults.scope;
  const offset = params.get('offset');
  return { scope, projectId: selectedProject, query: normalizeDocumentPublicationQuery(params.get('q') ?? ''),
    offset: offset && /^\d{1,7}$/u.test(offset) ? pageOffset(Number(offset)) : 0 };
}

export function appendDocumentPublicationCriteria(params: URLSearchParams, criteria: DocumentPublicationCriteria,
  tab: DocumentPublicationListTab, projectId: string): void {
  const defaults = defaultDocumentPublicationCriteria(tab, projectId);
  if (criteria.scope !== defaults.scope) params.set('scope', criteria.scope);
  if (criteria.projectId !== defaults.projectId && validProjectId(criteria.projectId)) params.set('projectId', criteria.projectId);
  const query = normalizeDocumentPublicationQuery(criteria.query);
  const offset = pageOffset(criteria.offset);
  if (query) params.set('q', query);
  if (offset) params.set('offset', String(offset));
}

export function sameDocumentPublicationCriteria(left?: DocumentPublicationCriteria, right?: DocumentPublicationCriteria): boolean {
  return left === right || Boolean(left && right && left.scope === right.scope && left.projectId === right.projectId &&
    left.query === right.query && left.offset === right.offset);
}
