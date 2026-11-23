import {
  atlassianWebUrl, AtlassianReadError, parseAtlassianLink,
  type AtlassianLink, type ParsedAtlassianLink,
} from './atlassian-links.js';

export type AtlassianSearchTarget = Pick<AtlassianLink, 'targetType' | 'targetId'>;

function safeSearchPath(value: string): boolean {
  // URL resolves literal and escaped dot segments before exposing pathname.
  const path = /^https?:\/\/[^/?#]+(\/[^?#]*)/iu.exec(value.trim())?.[1];
  if (!path) return false;
  try {
    return path.split('/').every(segment =>
      decodeURIComponent(segment).split('/').every(part => part !== '.' && part !== '..'));
  } catch {
    return false;
  }
}

/** Resolve the source locator while excluding query values unrelated to it. */
export function parseAtlassianSearchInput(input: string): ParsedAtlassianLink | null {
  const url = atlassianWebUrl(input);
  if (!url || !input.isWellFormed() || !safeSearchPath(input)) return null;
  for (const product of ['jira', 'confluence'] as const) {
    try {
      const parsed = parseAtlassianLink(product, input);
      if (parsed.product === 'confluence') {
        const pageIds = url.searchParams.getAll('pageId');
        if (pageIds.length && (pageIds.length !== 1 || !('pageId' in parsed) || pageIds[0] !== parsed.pageId)) return null;
      }
      return parsed;
    } catch (error) {
      if (!(error instanceof AtlassianReadError)) throw error;
    }
  }
  return null;
}

export function sameAtlassianSearchAddress(a: ParsedAtlassianLink, b: ParsedAtlassianLink): boolean {
  if (a.origin !== b.origin || a.contextPath !== b.contextPath) return false;
  if (a.product === 'jira') return b.product === 'jira' && a.issueKey === b.issueKey;
  if (b.product === 'jira') return false;
  if ('pageId' in a) return 'pageId' in b && a.pageId === b.pageId;
  return 'title' in b && a.spaceKey === b.spaceKey && a.title === b.title;
}
