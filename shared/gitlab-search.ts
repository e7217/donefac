import { gitlabObjectSha, isGitlabBranchName } from './gitlab-links.js';
import type { GitlabLink } from './types.js';

export const GITLAB_SEARCH_INPUT_LIMIT = 8192;

const routes = { merge_request: 'merge_requests', branch: 'tree', commit: 'commit', pipeline: 'pipelines' } as const;
const kinds = { merge_requests: 'merge_request', tree: 'branch', commit: 'commit', pipelines: 'pipeline' } as const;
const repositorySegment = /^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u;
const headPrefix = 'refs/heads/';

interface ObjectAddress {
  origin: string;
  host: string;
  repository: string;
  kind: GitlabLink['kind'];
  id: string;
}

type SearchInput = { type: 'url'; address: ObjectAddress } | { type: 'merge_request'; repository: string; id: string } |
  { type: 'branch'; id: string; fullRef?: boolean } | { type: 'commit'; id: string };

function mergeRequestOrPipelineId(value: string): string | null {
  return /^[1-9]\d{0,15}$/u.test(value) && Number.isSafeInteger(Number(value)) ? value : null;
}

function fullSha(value: string): string | null {
  const sha = gitlabObjectSha(value);
  return sha && !/^0+$/u.test(sha) ? sha : null;
}

function repositoryPath(segments: string[]): string | null {
  return segments.length >= 2 && segments.every(segment => repositorySegment.test(segment)) ? segments.join('/') : null;
}

function objectAddress(input: unknown): ObjectAddress | null {
  if (typeof input !== 'string' || input.length > GITLAB_SEARCH_INPUT_LIMIT || !input.isWellFormed() ||
      /[\u0000-\u001f\u007f\\]/u.test(input)) return null;
  // Read raw segments because URL resolves literal and escaped dot segments before exposing pathname.
  const path = /^https?:\/\/[^/?#]+(\/[^?#]*)/iu.exec(input)?.[1];
  if (!path) return null;
  const match = /^\/(.+?)\/-\/(merge_requests|tree|commit|pipelines)\/(.+)$/u.exec(path) ??
    /^\/(.+)\/(merge_requests|pipelines)\/([1-9]\d*)$/u.exec(path);
  if (!match) return null;
  try {
    const url = new URL(input);
    const repository = repositoryPath(match[1].split('/').map(segment => decodeURIComponent(segment)));
    if (!repository) return null;
    const kind = kinds[match[2] as keyof typeof kinds];
    const value = decodeURIComponent(match[3]);
    const id = kind === 'branch' ? (isGitlabBranchName(value) ? value : null)
      : kind === 'commit' ? fullSha(value) : mergeRequestOrPipelineId(value);
    return id ? { origin: url.origin, host: url.host, repository, kind, id } : null;
  } catch {
    return null;
  }
}

function parseSearchInput(input: string): SearchInput | null {
  if (input.length > GITLAB_SEARCH_INPUT_LIMIT || !input.isWellFormed()) return null;
  const value = input.trim();
  if (/^https?:\/\//iu.test(value)) {
    const address = objectAddress(value);
    return address ? { type: 'url', address } : null;
  }
  if (value.startsWith(headPrefix)) {
    const branch = value.slice(headPrefix.length);
    return isGitlabBranchName(branch) ? { type: 'branch', id: branch, fullRef: true } : null;
  }

  const shorthand = /^(.*)!(\d+)$/u.exec(value);
  if (shorthand) {
    if (!shorthand[1]) return null;
    const repository = repositoryPath(shorthand[1].split('/'));
    const id = mergeRequestOrPipelineId(shorthand[2]);
    if (repository && id) return { type: 'merge_request', repository, id };
  }
  const sha = fullSha(value);
  if (sha) return { type: 'commit', id: sha };
  return isGitlabBranchName(value) ? { type: 'branch', id: value } : null;
}

export function normalizeGitlabSearchInput(input: string): string | null {
  const query = parseSearchInput(input);
  if (!query) return null;
  if (query.type === 'url') {
    const { origin, repository, kind, id } = query.address;
    const path = repository.split('/').map(segment => encodeURIComponent(segment)).join('/');
    const clean = `${origin}/${path}/-/${routes[kind]}/${encodeURIComponent(id)}`;
    return clean.length <= GITLAB_SEARCH_INPUT_LIMIT ? clean : null;
  }
  if (query.type === 'merge_request') return `${query.repository}!${query.id}`;
  return query.type === 'branch' && query.fullRef ? `${headPrefix}${query.id}` : query.id;
}

function matchLabel({ host, repository, kind, id }: ObjectAddress): string {
  const repo = `${host}/${repository}`;
  switch (kind) {
    case 'merge_request': return `GitLab MR ${repo}!${id}`;
    case 'branch': return `GitLab 브랜치 ${repo} · ${id}`;
    case 'commit': return `GitLab 커밋 ${repo} · ${id}`;
    case 'pipeline': return `GitLab 파이프라인 ${repo} #${id}`;
  }
}

function branchName(link: GitlabLink, address: ObjectAddress): string | undefined {
  if (link.state === 'deleted') return;
  if (link.kind === 'branch') {
    return link.state === 'active' && (link.sourceBranch === undefined || link.sourceBranch === address.id) ? address.id : undefined;
  }
  return isGitlabBranchName(link.sourceBranch) ? link.sourceBranch : undefined;
}

function matchedAddress(query: SearchInput, link: GitlabLink, address: ObjectAddress): ObjectAddress | null {
  if (query.type === 'url') {
    const requested = query.address;
    if (requested.kind !== address.kind || requested.origin !== address.origin ||
        requested.repository !== address.repository || requested.id !== address.id) return null;
    if (address.kind === 'branch' && branchName(link, address) === undefined) {
      return null;
    }
    return address;
  }
  if (query.type === 'merge_request') {
    return address.kind === 'merge_request' && query.repository === address.repository && query.id === address.id ? address : null;
  }
  if (query.type === 'commit') return address.kind === 'commit' && query.id === address.id ? address : null;
  return branchName(link, address) === query.id ? { ...address, kind: 'branch', id: query.id } : null;
}

export function matchingGitlabSearchLinks(links: readonly GitlabLink[], input: string): Map<string, string> {
  const matches = new Map<string, string>();
  const query = parseSearchInput(input);
  if (!query) return matches;
  const kind = query.type === 'url' ? query.address.kind : query.type;
  const id = query.type === 'url' ? query.address.id : query.id;
  const mergeRequestIid = kind === 'merge_request' ? Number(id) : null;
  for (const link of links) {
    if (!link || typeof link.issueId !== 'string' || !link.issueId) continue;
    if (kind !== link.kind && (query.type !== 'branch' || query.id !== link.sourceBranch)) continue;
    if (mergeRequestIid !== null && link.iid !== mergeRequestIid) continue;
    if (kind === 'branch' && (link.state === 'deleted' || (link.sourceBranch !== undefined && link.sourceBranch !== id))) continue;
    const address = objectAddress(link.webUrl);
    if (!address || address.kind !== link.kind) continue;
    if (link.kind === 'merge_request' && (!Number.isSafeInteger(link.iid) || address.id !== String(link.iid))) continue;
    const match = matchedAddress(query, link, address);
    if (!match) continue;
    const label = matchLabel(match);
    const previous = matches.get(link.issueId);
    if (!previous || label < previous) matches.set(link.issueId, label);
  }
  return matches;
}
