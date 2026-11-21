import { documentNodes } from '../shared/document-references.js';
import type { RichContent } from '../shared/types.js';

export type DocumentUrlReference = { attrs: Record<string, unknown>; key: 'href' | 'src'; value: string };
export const contentOriginPlaceholder = 'https://teamspace.invalid';
export const attachmentContentPath = /^\/api\/(?:attachments\/([\s\S]*)\/content|attachment-versions\/([\s\S]*)\/download)\/?$/iu;

export function* documentUrlReferences(content: RichContent): Generator<DocumentUrlReference> {
  for (const node of documentNodes(content)) {
    if (node.type === 'image' && typeof node.attrs?.src === 'string') {
      yield { attrs: node.attrs, key: 'src', value: node.attrs.src };
    }
    for (const mark of node.marks ?? []) {
      if (mark.type === 'link' && typeof mark.attrs?.href === 'string') {
        yield { attrs: mark.attrs, key: 'href', value: mark.attrs.href };
      }
    }
  }
}

export function isRelativeContentUrl(value: string) {
  return !/^(?:[a-z][a-z\d+.-]*:|[/\\]{2})/iu.test(value.trim());
}

export function parseContentUrl(value: string, origin?: string): URL | undefined {
  try {
    const url = new URL(value, origin);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch { return undefined; }
}

export function decodedContentPath(url: URL) {
  try { return decodeURIComponent(url.pathname); }
  catch { return url.pathname; }
}

export function workspaceContentOrigins(origins: readonly string[]): ReadonlySet<string> {
  return new Set(origins.flatMap(origin => {
    const url = parseContentUrl(origin);
    return url && !url.username && !url.password ? [url.origin] : [];
  }));
}

export function workspaceContentUrl(value: string, origins: ReadonlySet<string>): URL | undefined {
  const base = origins.values().next().value ?? contentOriginPlaceholder;
  const url = parseContentUrl(value, base);
  return url && ((isRelativeContentUrl(value) && url.origin === base) || origins.has(url.origin)) ? url : undefined;
}
