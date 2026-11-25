import { atlassianWebUrl, isConfluencePageId, type ParsedAtlassianLink } from './atlassian-links.js';
import { parseAtlassianSearchInput } from './atlassian-search.js';

export type JiraMigrationTargetAddress = Extract<ParsedAtlassianLink, { product: 'jira' }> & { commentId?: string };

export interface MigratedJiraTarget {
  issueId: string;
  commentId?: string;
}

export function jiraMigratedTargetAddress(value: string): JiraMigrationTargetAddress | null {
  const url = atlassianWebUrl(value);
  if (!url) return null;
  const address = parseAtlassianSearchInput(value);
  if (address?.product !== 'jira') return null;
  if (!address.commentId) return url.search || url.hash ? null : address;

  const seen = new Set<string>();
  for (const [key, selector] of url.searchParams) {
    if (seen.has(key) || !((key === 'focusedCommentId' || key === 'focusedId') && isConfluencePageId(selector) ||
        key === 'page' && selector === 'issuetabpanels:comment-tabpanel')) return null;
    seen.add(key);
  }
  // The search parser has already verified numeric selectors and their agreement.
  const fragment = decodeURIComponent(url.hash.slice(1));
  return fragment && fragment !== `comment-${address.commentId}` && fragment !== 'comments' ? null : address;
}
