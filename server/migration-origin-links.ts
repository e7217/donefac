import {
  AtlassianReadError,
  MAX_ATLASSIAN_LINK_URL_LENGTH,
  atlassianContextPath,
  atlassianWebUrl,
  isConfluencePageId,
  isJiraIssueKey,
  parseAtlassianLink,
  type AtlassianProduct,
} from '../shared/atlassian-links.js';
import type { LegacyRecord } from '../shared/types.js';

export interface MigrationOriginBase {
  origin: string;
  contextPath: string;
}

export interface ConfluenceMigrationPageAddress extends MigrationOriginBase {
  identity: { sourceId?: string; title?: string; spaceKey?: string };
}

const invalidAddressCharacters = /[\u0000-\u001f\u007f\\]/u;
const commentFragment = /^(?:comments?|(?:inline[-_]?comment|comment)[-_:]?\d+)$/iu;

function decodePagePart(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return invalidAddressCharacters.test(decoded) ? null : decoded;
  } catch {
    return null;
  }
}

function safePagePath(value: string): boolean {
  // URL removes dot segments before exposing pathname, so inspect the original address.
  const path = /^https?:\/\/[^/?#]+(\/[^?#]*)/iu.exec(value)?.[1];
  return Boolean(path?.replace(/\/+$/u, '').slice(1).split('/').every(segment => {
    const decoded = decodePagePart(segment);
    return decoded !== null && decoded.length > 0 && decoded.split('/').every(part => part !== '.' && part !== '..');
  }));
}

function legacyConfluencePage(url: URL): ConfluenceMigrationPageAddress | null {
  const match = /^(.*)\/pages\/([^/]+)(?:\/([^/]+))?$/u.exec(url.pathname.replace(/\/+$/u, ''));
  if (!match || /\/spaces\/[^/]+$/u.test(match[1])) return null;
  const contextPath = atlassianContextPath(match[1]);
  const sourceId = decodePagePart(match[2]);
  const slug = match[3] === undefined ? undefined : decodePagePart(match[3]);
  if (contextPath === undefined || !isConfluencePageId(sourceId) || (match[3] !== undefined && (!slug || slug.includes('/')))) return null;
  return { origin: url.origin, contextPath, identity: { sourceId } };
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
    result = legacyConfluencePage(url);
  }
  if (!result || (pageIds.length && pageIds[0] !== result.identity.sourceId) ||
      (base && (result.origin !== base.origin || result.contextPath !== base.contextPath))) return null;
  return result;
}

export function parseMigrationOriginBase(product: AtlassianProduct, value: unknown): MigrationOriginBase | undefined {
  const url = atlassianWebUrl(value);
  if (!url || url.href.length > MAX_ATLASSIAN_LINK_URL_LENGTH || url.href.includes('?') || url.href.includes('#')) return undefined;
  const contextPath = atlassianContextPath(url.pathname);
  if (contextPath === undefined) return undefined;
  try {
    // A full item URL cannot be the prefix of the addresses generated below.
    parseAtlassianLink(product, url.href);
    return undefined;
  } catch (error) {
    if (!(error instanceof AtlassianReadError)) throw error;
  }
  return { origin: url.origin, contextPath };
}

export function isWithinMigrationOrigin(url: URL, base: MigrationOriginBase): boolean {
  if (url.origin !== base.origin) return false;
  if (!base.contextPath) return true;
  const segmentCount = base.contextPath.split('/').length;
  const requestedContext = url.pathname.split('/').slice(0, segmentCount).join('/');
  return atlassianContextPath(requestedContext) === base.contextPath;
}

export function migrationOriginLink(base: MigrationOriginBase, product: AtlassianProduct, row: LegacyRecord): string | undefined {
  let path: string;
  if (product === 'jira') {
    const sourceKey = row.metadata.key;
    if (row.kind !== 'issue' || !isJiraIssueKey(sourceKey)) return undefined;
    path = `/browse/${sourceKey}`;
  } else {
    const sourceClass = row.metadata.sourceClass;
    if (row.kind !== 'page' || (sourceClass !== undefined && sourceClass !== 'Page') || !isConfluencePageId(row.sourceId)) return undefined;
    path = `/pages/viewpage.action?pageId=${row.sourceId}`;
  }
  try {
    return parseAtlassianLink(product, `${base.origin}${base.contextPath}${path}`).url;
  } catch (error) {
    if (error instanceof AtlassianReadError) return undefined;
    throw error;
  }
}
