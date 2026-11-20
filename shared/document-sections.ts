import type { DocumentPublicationTarget } from './types.js';

const sectionIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const markdownImportSectionPrefix = 'teamspace-md-section-';

export function markdownImportSectionId(index: number): string {
  return `${markdownImportSectionPrefix}${index}`;
}

export function isMarkdownImportSectionId(value: unknown): value is string {
  return isDocumentSectionId(value) && value.startsWith(markdownImportSectionPrefix) &&
    /^[1-9]\d{0,4}$/.test(value.slice(markdownImportSectionPrefix.length));
}

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
