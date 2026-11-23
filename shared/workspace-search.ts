import { documentLabelKey, documentSearchText, normalizeDocumentLabel, normalizeDocumentLabelKey } from './document-labels.js';
import { documentPlainText } from './document-plain-text.js';
import { documentNodes } from './document-references.js';
import { isDocumentSectionId, outlineHeadingTitle } from './document-sections.js';
import { GITLAB_SEARCH_INPUT_LIMIT, matchingGitlabSearchLinks, normalizeGitlabSearchInput } from './gitlab-search.js';
import { parseAtlassianSearchInput } from './atlassian-search.js';
import { issueSearchText } from './issue-schema.js';
import type { DocPage, Issue, IssueSearchAlias, RichContent, WorkspaceSnapshot } from './types.js';
import { projectStatuses } from './workflow-helpers.js';

export interface WorkspaceSearchFilters {
  query: string;
  kind: 'all' | 'issue' | 'document';
  scope: string;
  label: string;
  page: number;
}

export const DEFAULT_WORKSPACE_SEARCH_FILTERS: WorkspaceSearchFilters = { query: '', kind: 'all', scope: '', label: '', page: 1 };
export const WORKSPACE_SEARCH_QUERY_LIMIT = 200;
export const WORKSPACE_SEARCH_INPUT_LIMIT = GITLAB_SEARCH_INPUT_LIMIT;
export type OriginalAddressMatches = { issueIds: ReadonlySet<string>; documentIds: ReadonlySet<string> };
const pageSize = 20;
const quickIssueLimit = 12;
const quickDocumentLimit = 8;
const excerptLimit = 160;
const collator = new Intl.Collator('ko-KR', { numeric: true, sensitivity: 'base' });
const httpUrlStart = /^https?:\/\//iu;

type IssueSearchMatch = { issue: Issue; matchedAliases?: IssueSearchAlias[]; matchedGitlab?: string };
type DocumentSearchMatch = { document: DocPage; sectionId?: string };
type IssueAliasData = Pick<WorkspaceSnapshot, 'issueAliases'>;
export type WorkspaceSearchDocument = { kind: 'document'; parentTitles: string[]; excerpt: string | null } & DocumentSearchMatch;
export type WorkspaceSearchResult = ({ kind: 'issue'; excerpt: string | null } & IssueSearchMatch) | WorkspaceSearchDocument;

type Match = { title: string; rank: number } & ({ kind: 'issue'; value: Issue; matchedAliases: IssueSearchAlias[]; matchedGitlab?: string }
  | { kind: 'document'; value: DocPage; bodyOnly?: boolean });

const documentSearchTextBlocks = new Set(['paragraph', 'codeBlock', 'detailsSummary']);

function readableText(value: string): string {
  return value.toWellFormed().normalize('NFKC').replace(/[\p{Cc}\s]+/gu, ' ').trim();
}

function searchKey(value: string): string {
  return readableText(value).toLowerCase();
}

function textSlice(value: string, start: number, end: number): string {
  return value.slice(start, end).replace(/^[\udc00-\udfff]|[\ud800-\udbff]$/g, '');
}

export function normalizeWorkspaceSearchQuery(input: string): string {
  return textSlice(readableText(input), 0, WORKSPACE_SEARCH_QUERY_LIMIT).trimEnd();
}

export function workspaceAtlassianSearchAddress(input: string) {
  if (!httpUrlStart.test(input.trim()) || normalizeGitlabSearchInput(input)) return null;
  return parseAtlassianSearchInput(input);
}

export function normalizeWorkspaceSearchInput(input: string): string {
  const trimmed = input.trim();
  const reference = normalizeGitlabSearchInput(trimmed);
  if (reference) return reference;
  if (!httpUrlStart.test(trimmed)) return normalizeWorkspaceSearchQuery(input);
  if (trimmed.length > WORKSPACE_SEARCH_INPUT_LIMIT) return '';
  const original = parseAtlassianSearchInput(trimmed);
  if (original) return original.url;
  // Keep the pasted path intact so an invalid GitLab reference stays invalid after sharing.
  const match = /^https?:\/\/[^/?#\\]+(\/[^?#]*)?(?=[?#]|$)/iu.exec(trimmed);
  if (!match || /[\u0000-\u001f\u007f\\]/u.test(match[0])) return '';
  try {
    const url = new URL(trimmed);
    const sanitized = `${url.origin}${match[1] ?? ''}`;
    // Removing userinfo or a conflicting page ID must not turn a rejected original address into a match.
    return sanitized.length <= WORKSPACE_SEARCH_INPUT_LIMIT && !parseAtlassianSearchInput(sanitized) ? sanitized : '';
  } catch {
    return '';
  }
}

export function issueSearchAliases(data: IssueAliasData, issueId: string): readonly IssueSearchAlias[] {
  const aliases = data.issueAliases;
  return aliases && Object.hasOwn(aliases, issueId) ? aliases[issueId] : [];
}

export function matchingIssueSearchAliases(data: IssueAliasData, issueId: string, normalizedQuery: string): IssueSearchAlias[] {
  if (!normalizedQuery) return [];
  return issueSearchAliases(data, issueId).filter(alias => searchKey(alias.key).includes(normalizedQuery));
}

export function issueSearchAliasLabel(alias: IssueSearchAlias): string {
  return `${alias.source === 'jira' ? 'Jira 원래 키' : '이동 전 키'} ${alias.key}`;
}

function issueKeyMatchRank(issue: Issue, query: string, aliases: readonly IssueSearchAlias[]): 0 | 1 | null {
  if (searchKey(issue.key) === query) return 0;
  return aliases.some(alias => searchKey(alias.key) === query) ? 1 : null;
}

export function searchQuickIssues(data: WorkspaceSnapshot, input: string, original?: OriginalAddressMatches): IssueSearchMatch[] {
  if (workspaceAtlassianSearchAddress(input)) {
    return data.issues.filter(issue => original?.issueIds.has(issue.id)).slice(0, quickIssueLimit).map(issue => ({ issue }));
  }
  const trimmed = input.trim();
  const textQuery = httpUrlStart.test(trimmed) ? normalizeWorkspaceSearchInput(trimmed).toLowerCase() : trimmed.toLocaleLowerCase();
  if (!textQuery) return [];
  const query = normalizeWorkspaceSearchQuery(input).toLowerCase();
  const gitlabMatches = matchingGitlabSearchLinks(data.gitlabLinks, input);
  const exactCurrent: IssueSearchMatch[] = [];
  const exactPrevious: IssueSearchMatch[] = [];
  const exactGitlab: IssueSearchMatch[] = [];
  const partial: IssueSearchMatch[] = [];
  for (const issue of data.issues) {
    const matchedAliases = matchingIssueSearchAliases(data, issue.id, query);
    const keyRank = issueKeyMatchRank(issue, query, matchedAliases);
    const matchedGitlab = gitlabMatches.get(issue.id);
    const match = { issue, ...(matchedAliases.length ? { matchedAliases } : {}), ...(matchedGitlab ? { matchedGitlab } : {}) };
    if (keyRank === 0) {
      exactCurrent.push(match);
      if (exactCurrent.length === quickIssueLimit) return exactCurrent;
    } else if (keyRank === 1) {
      if (exactPrevious.length < quickIssueLimit) exactPrevious.push(match);
    } else if (matchedGitlab) {
      if (exactGitlab.length < quickIssueLimit) exactGitlab.push(match);
    } else if (partial.length < quickIssueLimit && (matchedAliases.length || issueSearchText(data, issue).toLocaleLowerCase().includes(textQuery))) {
      partial.push(match);
    }
  }
  return [...exactCurrent, ...exactPrevious, ...exactGitlab, ...partial].slice(0, quickIssueLimit);
}

export function searchQuickDocuments(data: WorkspaceSnapshot, input: string, original?: OriginalAddressMatches): DocumentSearchMatch[] {
  if (workspaceAtlassianSearchAddress(input)) {
    return data.documents.filter(document => original?.documentIds.has(document.id)).slice(0, quickDocumentLimit)
      .map(document => ({ document }));
  }
  const query = documentLabelKey(input.trim());
  if (!query) return [];
  const matches = (text: string) => documentLabelKey(text).includes(query);
  return data.documents.filter(document => documentSearchText(document).includes(query)).slice(0, quickDocumentLimit)
    .map(document => {
      const match = matches(document.title) || (document.labels ?? []).some(matches) ? undefined : documentSearchSection(document, matches);
      return { document, ...(match ? { sectionId: match.sectionId } : {}) };
    });
}

function scopeMatches(projectId: string | null, scope: string): boolean {
  return !scope || (projectId === null ? scope === 'common' : scope === `project:${projectId}`);
}

function compareText(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

export function workspaceSearchLabels(data: WorkspaceSnapshot, scope: string): { key: string; name: string }[] {
  const labels = new Map<string, string>();
  for (const document of data.documents) {
    if (!scopeMatches(document.projectId, scope)) continue;
    for (const raw of document.labels ?? []) {
      const name = normalizeDocumentLabel(raw);
      const key = normalizeDocumentLabelKey(name);
      if (!name || !key) continue;
      const current = labels.get(key);
      if (!current || compareText(name, current) < 0) labels.set(key, name);
    }
  }
  return [...labels].map(([key, name]) => ({ key, name })).sort((a, b) => compareText(a.key, b.key));
}

function rankMatch(query: string, title: string, labels: readonly string[], searchableBody: () => string, partialAlias = false): number | null {
  if (!query || title === query) return 3;
  if (title.includes(query)) return 4;
  if (labels.some(label => searchKey(label).includes(query))) return 5;
  return partialAlias || searchKey(searchableBody()).includes(query) ? 6 : null;
}

function originalOffset(text: string, foldedIndex: number): number {
  // Lowercasing can expand a letter such as İ, so folded offsets may refer to different text positions.
  let index = 0;
  for (const character of text) {
    foldedIndex -= character.toLowerCase().length;
    if (foldedIndex < 0) break;
    index += character.length;
  }
  return index;
}

function excerptOf(value: string, query: string): string | null {
  const text = readableText(value);
  if (!text) return null;
  if (text.length <= excerptLimit) return text;

  const folded = text.toLowerCase();
  const match = query ? folded.indexOf(query) : -1;
  const position = match > 0 && folded.length !== text.length ? originalOffset(text, match) : match;
  const start = Math.min(Math.max(0, position - 36), text.length - excerptLimit + 1);
  const end = start + excerptLimit - Number(start > 0);
  const hasTail = end < text.length;
  const piece = textSlice(text, start, end - Number(hasTail)).trim();
  return `${start > 0 ? '…' : ''}${piece}${hasTail ? '…' : ''}`;
}

function documentSearchSection(document: DocPage, matches: (value: string) => boolean) {
  if (!matches(document.plainText)) return undefined;

  const seenIds = new Set<string>();
  const duplicates = new Set<string>();
  for (const node of documentNodes(document.content)) {
    const id = node.type === 'heading' ? node.attrs?.sectionId : undefined;
    if (!isDocumentSectionId(id)) continue;
    if (seenIds.has(id)) duplicates.add(id);
    seenIds.add(id);
  }
  if (seenIds.size === duplicates.size) return undefined;

  let match: { sectionId: string; text: string } | undefined;
  const withinOneSection = (text: string, sectionId?: string) => {
    if (!matches(text)) return true;
    if (!sectionId || (match && match.sectionId !== sectionId)) return false;
    match ??= { sectionId, text };
    return true;
  };
  const visit = (nodes: readonly RichContent[], inheritedSection?: string, reachable = true): boolean => {
    let sectionId = inheritedSection;
    for (const node of nodes) {
      if (node.type === 'heading') {
        const text = documentPlainText(node);
        const id = node.attrs?.sectionId;
        sectionId = reachable && isDocumentSectionId(id) && !duplicates.has(id) && outlineHeadingTitle(text) ? id : undefined;
        if (!withinOneSection(text, sectionId)) return false;
      } else if (documentSearchTextBlocks.has(node.type) || !node.content?.length) {
        if (!withinOneSection(documentPlainText(node), sectionId)) return false;
      } else {
        if (node.type === 'callout' && typeof node.attrs?.title === 'string' && !withinOneSection(node.attrs.title, sectionId)) return false;
        // A heading inside a folded block or column applies within that container.
        // A hidden excerpt still contributes to the page's text index but cannot be a navigation target.
        const childReachable = reachable && !(node.type === 'documentExcerpt' && node.attrs?.hidden === true);
        if (!visit(node.content, childReachable ? sectionId : undefined, childReachable)) return false;
      }
    }
    return true;
  };
  return visit(document.content.content ?? []) ? match : undefined;
}

function ancestorTitles(document: DocPage, byId: ReadonlyMap<string, DocPage>): string[] {
  const visited = new Set([document.id]);
  const titles: string[] = [];
  let id = document.parentId;
  while (id && !visited.has(id)) {
    const parent = byId.get(id);
    if (!parent || parent.projectId !== document.projectId) break;
    visited.add(id);
    if (typeof parent.title === 'string' && parent.title.trim()) titles.push(parent.title);
    id = parent.parentId;
  }
  return titles.reverse();
}

export function searchWorkspace(data: WorkspaceSnapshot, filters: WorkspaceSearchFilters, original?: OriginalAddressMatches): {
  items: WorkspaceSearchResult[]; total: number; page: number; pageCount: number;
} {
  const input = normalizeWorkspaceSearchInput(filters.query);
  const originalAddress = workspaceAtlassianSearchAddress(input);
  const query = httpUrlStart.test(input) ? input.toLowerCase() : searchKey(input);
  const label = normalizeDocumentLabelKey(filters.label);
  if ((!query && !label) || (filters.label && !label)) return { items: [], total: 0, page: 1, pageCount: 1 };

  const spaces = new Map(data.projects.map(({ id, key, name }) => [id, `${name} ${key}`]));
  const matches: Match[] = [];
  if (query && !label && filters.kind !== 'document') {
    const statuses = new Map(originalAddress ? [] : data.projects.map(({ id }) => [id, new Map(projectStatuses(data, id).map(status => [status.id, status.label]))]));
    const gitlabMatches = originalAddress ? null : matchingGitlabSearchLinks(data.gitlabLinks, filters.query);
    for (const issue of data.issues) {
      if (!scopeMatches(issue.projectId, filters.scope)) continue;
      const title = searchKey(issue.title);
      if (originalAddress) {
        if (original?.issueIds.has(issue.id)) matches.push({ kind: 'issue', value: issue, title, rank: 0, matchedAliases: [] });
        continue;
      }
      const status = statuses.get(issue.projectId)?.get(issue.status) ?? issue.status;
      const matchedAliases = matchingIssueSearchAliases(data, issue.id, query);
      const matchedGitlab = gitlabMatches?.get(issue.id);
      const rank = issueKeyMatchRank(issue, query, matchedAliases) ?? (matchedGitlab ? 2 : rankMatch(query, title, issue.labels, () =>
        `${issueSearchText(data, issue)} ${status} ${spaces.get(issue.projectId) ?? ''}`, matchedAliases.length > 0));
      if (rank !== null) matches.push({ kind: 'issue', value: issue, title, rank, matchedAliases, matchedGitlab });
    }
  }
  if (filters.kind !== 'issue') {
    for (const document of data.documents) {
      if (!scopeMatches(document.projectId, filters.scope)) continue;
      const labels = document.labels ?? [];
      if (label && !labels.some(value => normalizeDocumentLabelKey(value) === label)) continue;
      const title = searchKey(document.title);
      if (originalAddress) {
        if (original?.documentIds.has(document.id)) matches.push({ kind: 'document', value: document, title, rank: 0 });
        continue;
      }
      const space = document.projectId === null ? '팀 공통' : spaces.get(document.projectId) ?? '';
      const rank = rankMatch(query, title, labels, () => `${document.plainText} ${space}`);
      if (rank !== null) matches.push({ kind: 'document', value: document, title, rank,
        bodyOnly: rank === 6 && !searchKey(space).includes(query) });
    }
  }

  matches.sort((a, b) => a.rank - b.rank || compareText(a.title, b.title) ||
    Number(a.kind === 'document') - Number(b.kind === 'document') || compareText(a.value.projectId ?? '', b.value.projectId ?? '') ||
    (a.kind === 'issue' && b.kind === 'issue' ? compareText(a.value.key, b.value.key) : 0) || compareText(a.value.id, b.value.id));
  const total = matches.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pageCount, Math.max(1, Number.isSafeInteger(filters.page) ? filters.page : 1));
  const visible = matches.slice((page - 1) * pageSize, page * pageSize);
  const documentsById = new Map(visible.some(item => item.kind === 'document') ? data.documents.map(doc => [doc.id, doc]) : []);
  const items = visible.map((item): WorkspaceSearchResult => {
    if (item.kind === 'issue') return { kind: 'issue', issue: item.value, excerpt: excerptOf(item.value.description, query),
      ...(item.matchedAliases.length ? { matchedAliases: item.matchedAliases } : {}),
      ...(item.matchedGitlab ? { matchedGitlab: item.matchedGitlab } : {}) };
    const section = item.bodyOnly ? documentSearchSection(item.value, value => searchKey(value).includes(query)) : undefined;
    return { kind: 'document', document: item.value, parentTitles: ancestorTitles(item.value, documentsById),
      excerpt: excerptOf(section?.text ?? item.value.plainText, query), ...(section ? { sectionId: section.sectionId } : {}) };
  });
  return { items, total, page, pageCount };
}
