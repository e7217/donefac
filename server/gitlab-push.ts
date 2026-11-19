import { gitlabObjectSha, isGitlabBranchName } from '../shared/gitlab-links.js';

type PayloadFields = Record<string, unknown>;

export interface GitlabHeadPush {
  branch: string;
  before: string;
  after: string;
  deleted: boolean;
}

export function readGitlabHeadPush(payload: PayloadFields): GitlabHeadPush | null {
  const prefix = 'refs/heads/';
  if (typeof payload.ref !== 'string' || !payload.ref.startsWith(prefix)) return null;
  const branch = payload.ref.slice(prefix.length);
  const before = gitlabObjectSha(payload.before), after = gitlabObjectSha(payload.after);
  if (!isGitlabBranchName(branch) || !before || !after || before.length !== after.length || before === after) return null;
  const deleted = /^0+$/.test(after);
  if (payload.checkout_sha !== null && payload.checkout_sha !== undefined && gitlabObjectSha(payload.checkout_sha) !== after) return null;
  return { branch, before, after, deleted };
}

function parseWebUrl(input: unknown): URL | null {
  if (typeof input !== 'string' || input.length > 4000 || /[\u0000-\u001f\u007f\\]/.test(input)) return null;
  try {
    const url = new URL(input);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash ? url : null;
  } catch { return null; }
}

function scopePath(base: URL): string { return `${base.pathname.replace(/\/+$/, '')}/`; }

function withinScope(base: URL, url: URL) {
  const prefix = scopePath(base);
  if (url.origin !== base.origin || !url.pathname.startsWith(prefix)) return false;
  try {
    const suffix = decodeURIComponent(url.pathname.slice(prefix.length));
    return !/[\u0000-\u001f\u007f\\]/.test(suffix) && suffix.split('/').every(segment => segment !== '.' && segment !== '..');
  } catch { return false; }
}

// GitLab repository paths contain slugs for the namespace, optional subgroups, and project.
function repositoryPath(value: string): string | null {
  const segments = value.split('/');
  if (segments.length < 2 || segments.some(segment => !/^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u.test(segment))) return null;
  try { return segments.map(encodeURIComponent).join('/'); }
  catch { return null; }
}

export function gitlabRepositoryUrl(baseUrl: string, project: PayloadFields): URL | null {
  const base = parseWebUrl(baseUrl);
  if (!base) return null;

  const namespace = typeof project.path_with_namespace === 'string' && project.path_with_namespace.length <= 2000 && repositoryPath(project.path_with_namespace);
  if (namespace) {
    base.pathname = `${scopePath(base)}${namespace}`;
    return base;
  }

  const supplied = parseWebUrl(project.web_url);
  if (!supplied || !withinScope(base, supplied)) return null;
  try {
    const suffix = supplied.pathname.slice(scopePath(base).length).replace(/\/+$/, '');
    const path = repositoryPath(suffix.split('/').map(segment => {
      const decoded = decodeURIComponent(segment);
      return decoded.includes('/') ? '' : decoded;
    }).join('/'));
    if (!path) return null;
    base.pathname = `${scopePath(base)}${path}`;
    return base;
  } catch { return null; }
}

export function gitlabPushLinkUrl(project: URL, route: 'commit' | 'tree', value: string): string | null {
  try {
    const url = `${project.toString()}/-/${route}/${encodeURIComponent(value)}`;
    return url.length <= 4000 ? url : null;
  } catch { return null; }
}

export function gitlabScopedPushUrl(baseUrl: string, candidate: unknown): string | null {
  const base = parseWebUrl(baseUrl), url = parseWebUrl(candidate);
  return base && url && withinScope(base, url) ? url.toString() : null;
}
