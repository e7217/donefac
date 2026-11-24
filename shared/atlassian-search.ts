import {
  atlassianWebUrl, AtlassianReadError, isConfluencePageId, MAX_ATLASSIAN_LINK_URL_LENGTH, parseAtlassianLink,
  type AtlassianLink, type ParsedAtlassianLink,
} from './atlassian-links.js';

export type AtlassianSearchAddress = ParsedAtlassianLink & { commentId?: string };
export type AtlassianSearchTarget = Pick<AtlassianLink, 'targetType' | 'targetId'> & { commentId?: string };

const commentParam = 'focusedCommentId';
const jiraAlternateCommentParam = 'focusedId';
const commentParamAliases = new Set(['focusedcommentid', 'commentid', 'inlinecommentid']);
const commentFragmentPrefix = /^(?:comment|inline[-_]?comment)(?:[-_:]|\d)/iu;

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

function sourceCommentId(url: URL, product: ParsedAtlassianLink['product']): string | null | undefined {
  for (const name of url.searchParams.keys()) {
    if (name !== commentParam && commentParamAliases.has(name.toLowerCase())) return null;
    if (product === 'jira' && name !== jiraAlternateCommentParam && name.toLowerCase() === 'focusedid') return null;
  }
  const [focused, duplicate] = url.searchParams.getAll(commentParam);
  if (duplicate !== undefined || (focused !== undefined && !isConfluencePageId(focused))) return null;

  let fragment: string;
  try { fragment = decodeURIComponent(url.hash.slice(1)); }
  catch { return null; }
  if (product === 'jira' && url.searchParams.has(jiraAlternateCommentParam)) {
    const [alternate, duplicate] = url.searchParams.getAll(jiraAlternateCommentParam);
    if (focused !== undefined || duplicate !== undefined || !isConfluencePageId(alternate) || fragment !== `comment-${alternate}`) return null;
    return alternate;
  }
  if (!commentFragmentPrefix.test(fragment)) return focused;
  const anchored = fragment.startsWith('comment-') ? fragment.slice('comment-'.length) : undefined;
  if (!isConfluencePageId(anchored) || (focused !== undefined && focused !== anchored)) return null;
  return anchored;
}

/** Resolve the source locator while excluding query values unrelated to it. */
export function parseAtlassianSearchInput(input: string): AtlassianSearchAddress | null {
  const url = atlassianWebUrl(input);
  if (!url || !input.isWellFormed() || !safeSearchPath(input)) return null;
  for (const product of ['jira', 'confluence'] as const) {
    try {
      const parsed = parseAtlassianLink(product, input);
      if (parsed.product === 'confluence') {
        const pageIds = url.searchParams.getAll('pageId');
        if (pageIds.length && (pageIds.length !== 1 || !('pageId' in parsed) || pageIds[0] !== parsed.pageId)) return null;
      }
      const commentId = sourceCommentId(url, parsed.product);
      if (commentId === null) return null;
      if (commentId !== undefined) {
        const canonical = new URL(parsed.url);
        canonical.searchParams.set(commentParam, commentId);
        return canonical.href.length <= MAX_ATLASSIAN_LINK_URL_LENGTH ? { ...parsed, commentId, url: canonical.href } : null;
      }
      return parsed;
    } catch (error) {
      if (!(error instanceof AtlassianReadError)) throw error;
    }
  }
  return null;
}

/** Compare source page or issue identity. Resolve exact comment selectors separately. */
export function sameAtlassianSearchAddress(a: ParsedAtlassianLink, b: ParsedAtlassianLink): boolean {
  if (a.origin !== b.origin || a.contextPath !== b.contextPath) return false;
  if (a.product === 'jira') return b.product === 'jira' && a.issueKey === b.issueKey;
  if (b.product === 'jira') return false;
  if ('pageId' in a) return 'pageId' in b && a.pageId === b.pageId;
  return 'title' in b && a.spaceKey === b.spaceKey && a.title === b.title;
}
