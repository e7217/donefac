import { documentPlainText } from './document-plain-text.js';
import { documentNodes } from './document-references.js';
import type { DocumentPublicationTarget, RichContent } from './types.js';

const sectionIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const markdownImportSectionPrefix = 'donefac-md-section-';

export type DocumentHashTarget = {
  id: string;
  sectionId?: string;
  publication?: DocumentPublicationTarget;
  reading?: true;
};

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

export function savedDocumentSectionTitle(content: RichContent, sectionId: string): string | undefined {
  for (const node of documentNodes(content)) {
    if (node.type === 'heading' && node.attrs?.sectionId === sectionId) {
      return outlineHeadingTitle(documentPlainText(node));
    }
  }
  return undefined;
}

export function isDocumentReading(parameters: URLSearchParams): boolean {
  const modes = parameters.getAll('mode');
  return modes.length === 1 && modes[0] === 'read';
}

export function parseDocumentHash(hash: string, { allowLabel = false } = {}): DocumentHashTarget | undefined {
  const match = /^#\/[^/?#]+\/documents\/([^/?#]+)(?:\?([^#]*))?$/u.exec(hash);
  if (!match) return undefined;
  const query = new URLSearchParams(match[2]);
  const section = query.get('section');
  const revisionId = query.get('revision');
  const kind = query.get('publication');
  const reading = isDocumentReading(query);
  const fields = allowLabel ? ['section', 'revision', 'publication', 'label', 'mode'] : ['section', 'revision', 'publication', 'mode'];
  if ([...query.keys()].some(key => !fields.includes(key) || query.getAll(key).length !== 1) ||
      (section !== null && !isDocumentSectionId(section)) || ((kind === null) !== (revisionId === null)) ||
      (query.has('mode') && (!reading || kind !== null)) ||
      (kind !== null && kind !== 'published' && kind !== 'review') || (revisionId !== null && !revisionId)) return undefined;
  try {
    const id = decodeURIComponent(match[1]);
    if (!id || /[\u0000-\u001f\u007f]/u.test(id)) return undefined;
    const publication = kind && revisionId ? { kind, revisionId } satisfies DocumentPublicationTarget : undefined;
    return { id, ...(section ? { sectionId: section } : {}), ...(publication ? { publication } : {}), ...(reading ? { reading: true } : {}) };
  } catch {
    return undefined;
  }
}

export function documentReadingHash(documentId: string, projectId: string, sectionId?: string | null): string {
  const query = new URLSearchParams({ mode: 'read' });
  if (sectionId) query.set('section', sectionId);
  return `#/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}?${query.toString()}`;
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
