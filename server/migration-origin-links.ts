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
