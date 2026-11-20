import type { DocumentPublicationTarget } from './types.js';

const sectionIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;

export function isDocumentSectionId(value: unknown): value is string {
  return typeof value === 'string' && sectionIdPattern.test(value);
}

export function outlineHeadingTitle(text: string): string {
  return text.trim().replace(/\s+/gu, ' ').replace(/^(.{240}).+$/u, '$1…');
}

export function documentSectionHash(
  documentId: string,
  sectionId: string,
  projectId = 'all',
  publication?: DocumentPublicationTarget,
): string {
  const query = new URLSearchParams();
  if (publication) {
    query.set('publication', publication.kind);
    query.set('revision', publication.revisionId);
  }
  query.set('section', sectionId);
  return `#/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}?${query.toString()}`;
}
