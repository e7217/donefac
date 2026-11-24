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

import { decodePagePart, invalidAddressCharacters, safePagePath, type ConfluenceMigrationPageAddress, type MigrationOriginBase } from '../shared/confluence-migration-address.js';

export { confluenceMigrationPageAddress } from '../shared/confluence-migration-address.js';
export type { ConfluenceMigrationPageAddress, MigrationOriginBase } from '../shared/confluence-migration-address.js';

export function confluenceMigrationPageKey(origin: string, { sourceId, spaceKey, title }: ConfluenceMigrationPageAddress['identity']): string {
  return sourceId ? JSON.stringify([origin, 'id', sourceId]) : JSON.stringify([origin, 'title', spaceKey ?? '', title ?? '']);
}

interface ConfluenceAttachmentDownload {
  url: string;
  identity?: { sourcePageId: string; filename: string; version?: number };
}

export function isConfluenceAttachmentDownloadUrl(value: string): boolean {
  return /(?:^|\/)download\/attachments\//u.test(value.trim().split(/[?#]/u, 1)[0]);
}

export function confluenceAttachmentDownloadAddress(value: string, base: MigrationOriginBase): ConfluenceAttachmentDownload | null {
  if (value.length > MAX_ATLASSIAN_LINK_URL_LENGTH || !value.isWellFormed() || invalidAddressCharacters.test(value)) return null;
  const text = value.trim();
  const relative = text.replace(/^\.\//u, '');
  const absolute = /^https?:\/\//iu.test(text) ? text
    : /^download\/attachments\//u.test(relative) ? base.origin + base.contextPath + '/' + relative
    : /^\/(?!\/)/u.test(text) ? base.origin + text : '';
  const url = atlassianWebUrl(absolute);
  if (!url || url.origin !== base.origin || !safePagePath(absolute)) return null;
  const fallback = { url: url.href };
  const prefix = base.contextPath + '/download/attachments/';
  if (!url.pathname.startsWith(prefix)) return fallback;
  const [owner, rawFilename, ...extra] = url.pathname.slice(prefix.length).split('/');
  const sourcePageId = decodePagePart(owner);
  const filename = rawFilename && decodePagePart(rawFilename);
  if (extra.length || !isConfluencePageId(sourcePageId) || !filename || filename.includes('/') || filename === '.' || filename === '..') return fallback;

  // A file fragment or an unknown selector might change the requested representation.
  const seen = new Set<string>();
  if (url.hash) return fallback;
  for (const [key, queryValue] of url.searchParams) {
    if (seen.has(key) || !(key === 'version' || key === 'modificationDate' && /^\d{1,19}$/u.test(queryValue) ||
      key === 'api' && /^v[12]$/u.test(queryValue))) return fallback;
    seen.add(key);
  }
  const version = url.searchParams.get('version');
  if (version !== null && (!/^[1-9]\d*$/u.test(version) || !Number.isSafeInteger(Number(version)))) return fallback;
  return { ...fallback, identity: { sourcePageId, filename, ...(version === null ? {} : { version: Number(version) }) } };
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
