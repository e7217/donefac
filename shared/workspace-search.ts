import { normalizeDocumentLabel, normalizeDocumentLabelKey } from './document-labels.js';
import { issueSearchText } from './issue-schema.js';
import type { DocPage, Issue, IssueSearchAlias, WorkspaceSnapshot } from './types.js';
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
const pageSize = 20;
const quickIssueLimit = 12;
const excerptLimit = 160;
const collator = new Intl.Collator('ko-KR', { numeric: true, sensitivity: 'base' });

type IssueSearchMatch = { issue: Issue; matchedAliases?: IssueSearchAlias[] };
type IssueAliasData = Pick<WorkspaceSnapshot, 'issueAliases'>;
export type WorkspaceSearchResult = ({ kind: 'issue'; excerpt: string | null } & IssueSearchMatch) |
  { kind: 'document'; document: DocPage; parentTitles: string[]; excerpt: string | null };

type Match = { title: string; rank: number } & ({ kind: 'issue'; value: Issue; matchedAliases: IssueSearchAlias[] } | { kind: 'document'; value: DocPage });

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

export function searchQuickIssues(data: WorkspaceSnapshot, input: string): IssueSearchMatch[] {
  const textQuery = input.trim().toLocaleLowerCase();
  if (!textQuery) return [];
  const query = normalizeWorkspaceSearchQuery(input).toLowerCase();
  const exactCurrent: IssueSearchMatch[] = [];
  const exactPrevious: IssueSearchMatch[] = [];
  const partial: IssueSearchMatch[] = [];
  for (const issue of data.issues) {
    const matchedAliases = matchingIssueSearchAliases(data, issue.id, query);
    const keyRank = issueKeyMatchRank(issue, query, matchedAliases);
    const match = { issue, ...(matchedAliases.length ? { matchedAliases } : {}) };
    if (keyRank === 0) {
      exactCurrent.push(match);
      if (exactCurrent.length === quickIssueLimit) return exactCurrent;
    } else if (keyRank === 1) {
      if (exactPrevious.length < quickIssueLimit) exactPrevious.push(match);
    } else if (partial.length < quickIssueLimit && (matchedAliases.length || issueSearchText(data, issue).toLocaleLowerCase().includes(textQuery))) {
      partial.push(match);
    }
  }
  return [...exactCurrent, ...exactPrevious, ...partial].slice(0, quickIssueLimit);
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
  if (!query || title === query) return 2;
  if (title.includes(query)) return 3;
  if (labels.some(label => searchKey(label).includes(query))) return 4;
  return partialAlias || searchKey(searchableBody()).includes(query) ? 5 : null;
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

export function searchWorkspace(data: WorkspaceSnapshot, filters: WorkspaceSearchFilters): {
  items: WorkspaceSearchResult[]; total: number; page: number; pageCount: number;
} {
  const query = normalizeWorkspaceSearchQuery(filters.query).toLowerCase();
  const label = normalizeDocumentLabelKey(filters.label);
  if ((!query && !label) || (filters.label && !label)) return { items: [], total: 0, page: 1, pageCount: 1 };

  const spaces = new Map(data.projects.map(({ id, key, name }) => [id, `${name} ${key}`]));
  const matches: Match[] = [];
  if (query && !label && filters.kind !== 'document') {
    const statuses = new Map(data.projects.map(({ id }) => [id, new Map(projectStatuses(data, id).map(status => [status.id, status.label]))]));
    for (const issue of data.issues) {
      if (!scopeMatches(issue.projectId, filters.scope)) continue;
      const title = searchKey(issue.title);
      const status = statuses.get(issue.projectId)?.get(issue.status) ?? issue.status;
      const matchedAliases = matchingIssueSearchAliases(data, issue.id, query);
      const rank = issueKeyMatchRank(issue, query, matchedAliases) ?? rankMatch(query, title, issue.labels, () =>
        `${issueSearchText(data, issue)} ${status} ${spaces.get(issue.projectId) ?? ''}`, matchedAliases.length > 0);
      if (rank !== null) matches.push({ kind: 'issue', value: issue, title, rank, matchedAliases });
    }
  }
  if (filters.kind !== 'issue') {
    for (const document of data.documents) {
      if (!scopeMatches(document.projectId, filters.scope)) continue;
      const labels = document.labels ?? [];
      if (label && !labels.some(value => normalizeDocumentLabelKey(value) === label)) continue;
      const title = searchKey(document.title);
      const space = document.projectId === null ? '팀 공통' : spaces.get(document.projectId) ?? '';
      const rank = rankMatch(query, title, labels, () => `${document.plainText} ${space}`);
      if (rank !== null) matches.push({ kind: 'document', value: document, title, rank });
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
  const items = visible.map((item): WorkspaceSearchResult => item.kind === 'issue'
    ? { kind: 'issue', issue: item.value, excerpt: excerptOf(item.value.description, query),
      ...(item.matchedAliases.length ? { matchedAliases: item.matchedAliases } : {}) }
    : { kind: 'document', document: item.value, parentTitles: ancestorTitles(item.value, documentsById), excerpt: excerptOf(item.value.plainText, query) });
  return { items, total, page, pageCount };
}
