export type AtlassianProduct = 'jira' | 'confluence';
export type AtlassianLinkTarget = 'issue' | 'document';

export interface AtlassianLink {
  id: string;
  targetType: AtlassianLinkTarget;
  targetId: string;
  product: AtlassianProduct;
  url: string;
  createdAt: string;
}

export interface AtlassianLinkPreview {
  title: string;
  status: string | null;
  locator: string;
  updatedAt: string | null;
}

export class AtlassianReadError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'AtlassianReadError';
  }
}

type LinkAddress = { url: string; origin: string; contextPath: string };
export type ParsedAtlassianLink = LinkAddress & (
  | { product: 'jira'; issueKey: string }
  | { product: 'confluence'; pageId: string }
  | { product: 'confluence'; spaceKey: string; title: string }
);

export const MAX_ATLASSIAN_LINK_URL_LENGTH = 2048;
const controlCharacter = /[\u0000-\u001f\u007f]/u;
const jiraKey = /^[A-Za-z][A-Za-z0-9_]{0,127}-[1-9]\d{0,19}$/u;
const confluencePageId = /^[1-9]\d{0,19}$/u;

export function isJiraIssueKey(value: unknown): value is string {
  return typeof value === 'string' && jiraKey.test(value);
}

export function isConfluencePageId(value: unknown): value is string {
  return typeof value === 'string' && confluencePageId.test(value);
}

export function atlassianWebUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || value.length > MAX_ATLASSIAN_LINK_URL_LENGTH ||
      controlCharacter.test(value) || value.includes('\\')) return undefined;
  const text = value.trim();
  const authority = /^https?:\/\/([^/?#]+)(?:[/?#]|$)/iu.exec(text)?.[1];
  if (!authority || authority.includes('@') || /\s/u.test(authority)) return undefined;
  try {
    const url = new URL(text);
    if (!url.username && !url.password) return url;
  } catch { /* Invalid URLs use the same localized validation result. */ }
  return undefined;
}

function decode(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    return controlCharacter.test(decoded) || decoded.includes('\\') ? undefined : decoded;
  } catch { return undefined; }
}

function pathSegments(pathname: string): string[] {
  const path = pathname.replace(/\/+$/u, '').slice(1);
  return path ? path.split('/') : [];
}

function contextPath(segments: readonly string[]): string | undefined {
  const normalized: string[] = [];
  for (const segment of segments) {
    const value = decode(segment);
    // App context segments must not introduce path separators when decoded by a proxy.
    if (!value || !/^[A-Za-z0-9._~-]+$/u.test(value) || value === '.' || value === '..') return undefined;
    normalized.push(value);
  }
  return normalized.length ? `/${normalized.join('/')}` : '';
}

export function atlassianContextPath(pathname: string): string | undefined {
  return contextPath(pathSegments(pathname));
}

function aSegment(raw: string): string | undefined {
  const value = decode(raw);
  if (!value || value === '.' || value === '..' || value.includes('/')) return undefined;
  return value;
}

function invalidLink(product: AtlassianProduct): never {
  throw new AtlassianReadError(400, product === 'jira' ? 'Jira 업무 주소를 확인해 주세요.' : 'Confluence 페이지 주소를 확인해 주세요.');
}

/** Parse a browser URL and retain only path and query values needed to open the linked item. */
export function parseAtlassianLink(product: unknown, value: unknown): ParsedAtlassianLink {
  if (product !== 'jira' && product !== 'confluence') throw new AtlassianReadError(400, '원본 도구를 확인해 주세요.');
  const url = atlassianWebUrl(value);
  if (!url) return invalidLink(product);
  const segments = pathSegments(url.pathname);
  const pageIds = url.searchParams.getAll('pageId');
  url.search = '';
  url.hash = '';

  const address = (context: string, path: string, query?: URLSearchParams): LinkAddress => {
    url.pathname = `${context}${path}`;
    if (query) url.search = query.toString();
    if (url.href.length > MAX_ATLASSIAN_LINK_URL_LENGTH) return invalidLink(product);
    return { url: url.href, origin: url.origin, contextPath: context };
  };

  const leaf = segments.at(-1) ?? '';
  if (product === 'jira') {
    const key = decode(leaf);
    const context = contextPath(segments.slice(0, -2));
    if (segments.at(-2) !== 'browse' || !isJiraIssueKey(key) || context === undefined) return invalidLink(product);
    const issueKey = key.toUpperCase();
    return { ...address(context, `/browse/${issueKey}`), product, issueKey };
  }

  if (segments.at(-2) === 'pages' && leaf === 'viewpage.action') {
    const context = contextPath(segments.slice(0, -2));
    if (pageIds.length !== 1 || !isConfluencePageId(pageIds[0]) || context === undefined) return invalidLink(product);
    const [pageId] = pageIds;
    return { ...address(context, '/pages/viewpage.action', new URLSearchParams({ pageId })), product, pageId };
  }

  if (segments.at(-3) === 'display') {
    const context = contextPath(segments.slice(0, -3));
    const spaceKey = aSegment(segments.at(-2)!);
    const title = decode(leaf.replaceAll('+', ' '));
    if (context === undefined || !spaceKey || spaceKey.length > 255 || !title?.trim() || title.length > 500 || title === '.' || title === '..') {
      return invalidLink(product);
    }
    const displayTitle = encodeURIComponent(title).replaceAll('%20', '+');
    return { ...address(context, `/display/${encodeURIComponent(spaceKey)}/${displayTitle}`), product, spaceKey, title };
  }

  const withSlug = segments.at(-5) === 'spaces' && segments.at(-3) === 'pages';
  const suffixLength = withSlug ? 5 : 4;
  const [directory, space, pages, rawPageId, rawSlug] = segments.slice(-suffixLength);
  const spaceKey = space && aSegment(space);
  const pageId = rawPageId && decode(rawPageId);
  const slug = rawSlug && decode(rawSlug);
  const context = contextPath(segments.slice(0, -suffixLength));
  if (directory !== 'spaces' || pages !== 'pages' || !spaceKey || spaceKey.length > 255 ||
      !isConfluencePageId(pageId) || (withSlug && (!slug || slug === '.' || slug === '..')) || context === undefined) {
    return invalidLink(product);
  }
  const path = `/spaces/${encodeURIComponent(spaceKey)}/pages/${pageId}${slug ? `/${encodeURIComponent(slug)}` : ''}`;
  return { ...address(context, path), product, pageId };
}
