import { contentReferences, documentPlainText } from './document-nodes.js';
import { documentNodes } from './document-references.js';
import { outlineHeadingTitle, parseDocumentHash } from './document-sections.js';
import type { ContentReference, DocPage, RichContent } from './types.js';

type WorkspaceLocation = { origin: string; pathname: string };
export type DocumentPanelReference = Omit<ContentReference, 'type'> & { linkMark?: true; sectionId?: string };

function workspaceDocumentLink(href: string, location?: WorkspaceLocation) {
  if (/[\\\u0000-\u0020\u007f]/u.test(href)) return undefined;
  if (href.startsWith('#')) return parseDocumentHash(href, { allowLabel: true });
  if (href.startsWith('/#') && location?.pathname === '/') return parseDocumentHash(href.slice(1), { allowLabel: true });
  if (!location || !/^https?:\/\/[^/]/iu.test(href)) return undefined;
  try {
    const url = new URL(href);
    if (url.origin === location.origin && url.pathname === location.pathname && !url.username && !url.password) {
      return parseDocumentHash(url.hash, { allowLabel: true });
    }
  } catch { /* Malformed links remain ordinary text links. */ }
  return undefined;
}

export function documentPanelReferenceKey({ id, kind, revisionId, sectionId }: DocumentPanelReference): string {
  return JSON.stringify([id, kind, revisionId, sectionId]);
}

export function documentPanelReferences(content: RichContent, location?: WorkspaceLocation): DocumentPanelReference[] {
  const destinations = new Map<string, DocumentPanelReference>();
  for (const reference of contentReferences(content)) {
    if (reference.type === 'document') destinations.set(documentPanelReferenceKey(reference), reference);
  }
  for (const node of documentNodes(content)) for (const mark of node.marks ?? []) {
    if (mark.type !== 'link' || typeof mark.attrs?.href !== 'string') continue;
    const target = workspaceDocumentLink(mark.attrs.href, location);
    if (!target || target.publication) continue;
    const { id, sectionId } = target;
    const reference: DocumentPanelReference = { id, kind: 'reference', linkMark: true,
      label: typeof node.text === 'string' ? outlineHeadingTitle(node.text) : '', ...(sectionId ? { sectionId } : {}) };
    const key = documentPanelReferenceKey(reference);
    if (!destinations.has(key)) destinations.set(key, reference);
  }
  return [...destinations.values()];
}

export function documentPanelBacklinks(documents: readonly DocPage[], id: string, location?: WorkspaceLocation) {
  return documents.flatMap(document => {
    if (document.id === id) return [];
    const matches = documentPanelReferences(document.content, location).filter(reference => reference.id === id);
    const include = matches.some(reference => reference.kind === 'include');
    const reference = matches.some(reference => !reference.linkMark);
    return matches.length ? [{ document, label: include ? '내 문서를 포함함' : reference ? '내 문서를 참조함' : '내 문서에 링크함' }] : [];
  });
}

export function savedDocumentSectionTitle(content: RichContent, sectionId: string): string | undefined {
  for (const node of documentNodes(content)) {
    if (node.type === 'heading' && node.attrs?.sectionId === sectionId) {
      return outlineHeadingTitle(documentPlainText(node));
    }
  }
  return undefined;
}
