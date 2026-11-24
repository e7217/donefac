import { gitlabObjectSha, isGitlabBranchName } from './gitlab-links.js';
import { isGitlabMergeReadinessBlocked } from './gitlab-merge-readiness.js';
import { GITLAB_SEARCH_INPUT_LIMIT, normalizeGitlabSearchInput } from './gitlab-search.js';
import { latestGitlabPipelineLinks } from './issue-gitlab-view.js';
import type { GitlabLink, WorkspaceSnapshot } from './types.js';
import { issueSearchAliases, normalizeWorkspaceSearchKey, normalizeWorkspaceSearchQuery } from './workspace-search.js';

export const GITLAB_ACTIVITY_SCOPES = [
  'all', 'merge_request', 'open_merge_requests', 'blocked_merge_requests',
  'pipeline', 'failed_pipelines', 'manual_pipelines', 'branch', 'commit',
] as const;
export type GitlabActivityScope = typeof GITLAB_ACTIVITY_SCOPES[number];

export interface GitlabActivityFilters {
  scope: GitlabActivityScope;
  query: string;
  pages: Partial<Record<GitlabLink['kind'], number>>;
}

export const DEFAULT_GITLAB_ACTIVITY_FILTERS: GitlabActivityFilters = { scope: 'all', query: '', pages: {} };
export const GITLAB_ACTIVITY_QUERY_LIMIT = GITLAB_SEARCH_INPUT_LIMIT;

const activityPages = [
  ['merge_request', 'activityMrPage'], ['pipeline', 'activityPipelinePage'],
  ['branch', 'activityBranchPage'], ['commit', 'activityCommitPage'],
] as const;
const objectRoutes = { merge_request: 'merge_requests', pipeline: 'pipelines', branch: 'tree', commit: 'commit' } as const;
const httpUrlStart = /^https?:\/\//iu;
const urlLike = /(?:https?:\s*[/\\]|[a-z][a-z\d+.-]*:[/\\]{2}|(?:^|\s)[/\\]{2})/iu;

export function normalizeGitlabActivityQuery(input: string): string {
  const value = input.trim();
  if (value.length > GITLAB_ACTIVITY_QUERY_LIMIT) return '';
  if (httpUrlStart.test(value)) return normalizeGitlabSearchInput(value) ?? '';
  if (urlLike.test(value.normalize('NFKC'))) return '';
  return normalizeWorkspaceSearchQuery(value);
}

function isActivityPage(value: number | undefined): value is number {
  return typeof value === 'number' && value > 1 && Number.isSafeInteger(value);
}

export function readGitlabActivityFilters(params: URLSearchParams): GitlabActivityFilters {
  const rawScope = params.get('activityScope');
  const scope = GITLAB_ACTIVITY_SCOPES.find(value => value === rawScope) ?? 'all';
  const query = normalizeGitlabActivityQuery(params.get('activityQ') ?? '');
  const pages: GitlabActivityFilters['pages'] = {};
  for (const [kind, key] of activityPages) {
    const raw = params.get(key);
    if (!raw || !/^[1-9]\d{0,15}$/u.test(raw)) continue;
    const page = Number(raw);
    if (isActivityPage(page)) pages[kind] = page;
  }
  return { scope, query, pages };
}

export function appendGitlabActivityFilters(params: URLSearchParams, filters: GitlabActivityFilters): void {
  if (filters.scope === 'all') params.delete('activityScope');
  else params.set('activityScope', filters.scope);

  const query = normalizeGitlabActivityQuery(filters.query);
  if (query) params.set('activityQ', query);
  else params.delete('activityQ');

  for (const [kind, key] of activityPages) {
    const page = filters.pages[kind];
    if (isActivityPage(page)) params.set(key, String(page));
    else params.delete(key);
  }
}

function canonicalLinkAddress(link: GitlabLink) {
  if (!httpUrlStart.test(link.webUrl)) return null;
  const canonical = normalizeGitlabSearchInput(link.webUrl);
  if (!canonical) return null;
  const url = new URL(canonical);
  const [path, object] = url.pathname.split('/-/');
  const route = `${objectRoutes[link.kind]}/`;
  if (!object?.startsWith(route)) return null;
  const ref = decodeURIComponent(object.slice(route.length));
  if (link.kind === 'merge_request' && ref !== String(link.iid)) return null;
  return { canonical, repository: decodeURIComponent(path.slice(1)), ref, host: url.host };
}

function matchesScope(link: GitlabLink, scope: GitlabActivityScope, latest: ReadonlySet<GitlabLink> | null): boolean {
  switch (scope) {
    case 'all': return true;
    case 'open_merge_requests': return link.kind === 'merge_request' && link.state === 'opened';
    case 'blocked_merge_requests': return link.kind === 'merge_request' && link.state === 'opened' &&
      isGitlabMergeReadinessBlocked(link.mergeReadiness?.state);
    case 'failed_pipelines': return latest?.has(link) === true && link.state === 'failed';
    case 'manual_pipelines': return latest?.has(link) === true && link.state === 'manual';
    default: return link.kind === scope;
  }
}

type ActivitySearchData = Pick<WorkspaceSnapshot, 'issues' | 'issueAliases'>;

export function filterGitlabActivityLinks(
  data: ActivitySearchData, links: readonly GitlabLink[], filters: GitlabActivityFilters,
): GitlabLink[] {
  const latest = filters.scope === 'failed_pipelines' || filters.scope === 'manual_pipelines'
    ? new Set(latestGitlabPipelineLinks(links)) : null;
  const scoped = links.filter(link => matchesScope(link, filters.scope, latest));
  const query = normalizeGitlabActivityQuery(filters.query);
  if (!query) return scoped;
  if (httpUrlStart.test(query)) return scoped.filter(link => canonicalLinkAddress(link)?.canonical === query);

  const terms = normalizeWorkspaceSearchKey(query).split(' ');
  const issues = new Map(data.issues.map(issue => [issue.id, issue]));
  return scoped.filter(link => {
    const issue = issues.get(link.issueId);
    const address = canonicalLinkAddress(link);
    const branch = isGitlabBranchName(link.sourceBranch) ? link.sourceBranch : null;
    const repositoryWithHost = address && `${address.host}/${address.repository}`;
    const hasNumber = Number.isSafeInteger(link.iid) && link.iid > 0;
    const number = hasNumber && link.kind === 'merge_request' ? `!${link.iid}` : hasNumber && link.kind === 'pipeline' ? `#${link.iid}` : null;
    const shorthand = address && link.kind === 'merge_request' ? `${address.repository}${number}` : null;
    const searchText = normalizeWorkspaceSearchKey([
      issue?.key, issue?.title, ...issueSearchAliases(data, link.issueId).map(alias => alias.key), link.originalJiraKey,
      link.title, address?.repository, repositoryWithHost, address?.ref, number, shorthand,
      branch, branch && `refs/heads/${branch}`, gitlabObjectSha(link.sourceSha), link.projectId,
    ].join(' '));
    return terms.every(term => /^[!#]\d+$/u.test(term) ? term === number : searchText.includes(term));
  });
}
