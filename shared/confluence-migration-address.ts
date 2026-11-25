import {
  AtlassianReadError, MAX_ATLASSIAN_LINK_URL_LENGTH, atlassianContextPath,
  atlassianWebUrl, isConfluencePageId, parseAtlassianLink,
} from './atlassian-links.js';

export interface MigrationOriginBase {
  origin: string;
  contextPath: string;
}

export interface ConfluenceMigrationPageAddress extends MigrationOriginBase {
  identity: { sourceId?: string; title?: string; spaceKey?: string };
  fragment?: string;
  hasExtraQuery?: true;
}

export interface MigratedConfluenceDocumentTarget {
  documentId: string;
  sectionId?: string;
}

export const invalidAddressCharacters = /[\u0000-\u001f\u007f\\]/u;
const commentFragment = /^(?:comments?|(?:inline[-_]?comment|comment)[-_:]?\d+)$/iu;

export function decodePagePart(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return invalidAddressCharacters.test(decoded) ? null : decoded;
  } catch {
    return null;
  }
}

export function safePagePath(value: string): boolean {
  // URL removes dot segments before exposing pathname, so inspect the original address.
  const path = /^https?:\/\/[^/?#]+(\/[^?#]*)/iu.exec(value)?.[1];
  return Boolean(path?.replace(/\/+$/u, '').slice(1).split('/').every(segment => {
    const decoded = decodePagePart(segment);
    return decoded !== null && decoded.length > 0 && decoded.split('/').every(part => part !== '.' && part !== '..');
  }));
}

export function legacyConfluencePagePath(pathname: string): { contextPath: string; pageId: string } | null {
  const match = /^(.*)\/pages\/([^/]+)(?:\/([^/]+))?$/u.exec(pathname.replace(/\/+$/u, ''));
  if (!match || /\/spaces\/[^/]+$/u.test(match[1])) return null;
  const contextPath = atlassianContextPath(match[1]);
  const pageId = decodePagePart(match[2]);
  const slug = match[3] === undefined ? undefined : decodePagePart(match[3]);
  if (contextPath === undefined || !isConfluencePageId(pageId) || (match[3] !== undefined && (!slug || slug.includes('/')))) return null;
  return { contextPath, pageId };
}

export function confluenceMigrationPageAddress(value: string, base?: MigrationOriginBase): ConfluenceMigrationPageAddress | null {
  if (typeof value !== 'string' || value.length > MAX_ATLASSIAN_LINK_URL_LENGTH || !value.isWellFormed() || invalidAddressCharacters.test(value)) return null;
  const text = value.trim();
  let address = text;
  if (!/^https?:\/\//iu.test(text)) {
    if (!base || text.startsWith('//')) return null;
    const relative = text.replace(/^\.\//u, '');
    if (text.startsWith('/')) address = `${base.origin}${text}`;
    else if (/^(?:pages|display|spaces|x)\//u.test(relative)) address = `${base.origin}${base.contextPath}/${relative}`;
    else if (/^viewpage\.action(?=[?#]|$)/u.test(relative)) address = `${base.origin}${base.contextPath}/pages/${relative}`;
    else if (text.startsWith('?')) address = `${base.origin}${base.contextPath}/pages/viewpage.action${text}`;
    else return null;
  }
  const url = atlassianWebUrl(address);
  if (!url || !safePagePath(address)) return null;
  const pageIds = url.searchParams.getAll('pageId');
  const fragment = decodePagePart(url.hash.slice(1));
  if (pageIds.length > 1 || fragment === null || commentFragment.test(fragment) ||
      ['focusedCommentId', 'commentId', 'inlineCommentId'].some(name => url.searchParams.has(name))) return null;

  let result: ConfluenceMigrationPageAddress | null;
  try {
    const parsed = parseAtlassianLink('confluence', address);
    if (parsed.product !== 'confluence') return null;
    const identity = 'pageId' in parsed ? { sourceId: parsed.pageId } : { spaceKey: parsed.spaceKey, title: parsed.title };
    result = { origin: parsed.origin, contextPath: parsed.contextPath, identity };
  } catch (error) {
    if (!(error instanceof AtlassianReadError)) throw error;
    const legacy = legacyConfluencePagePath(url.pathname);
    result = legacy ? { origin: url.origin, contextPath: legacy.contextPath, identity: { sourceId: legacy.pageId } } : null;
  }
  if (!result || (pageIds.length && pageIds[0] !== result.identity.sourceId) ||
      (base && (result.origin !== base.origin || result.contextPath !== base.contextPath))) return null;
  return { ...result, ...(fragment ? { fragment } : {}),
    ...([...url.searchParams.keys()].some(key => key !== 'pageId') ? { hasExtraQuery: true } : {}) };
}

export function confluenceMigratedDocumentAddress(value: string): ConfluenceMigrationPageAddress | null {
  if (!/^https?:\/\//iu.test(value.trim())) return null;
  const address = confluenceMigrationPageAddress(value);
  const fragment = address?.fragment ?? '';
  if (!address || address.hasExtraQuery || fragment.length > 600 ||
      /^(?:inline[-_]?comments?|comments?|versions?)(?:[-_:]|\d|$)/iu.test(fragment)) return null;
  return address;
}
