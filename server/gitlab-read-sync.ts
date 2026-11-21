import { gitlabObjectSha, isGitlabBranchName } from '../shared/gitlab-links.js';
import type { GitlabProjectWebhook, GitlabProjectWebhookAuthMode } from '../shared/gitlab-project-webhooks.js';
import type { GitlabRepositoryCandidate, GitlabRepositorySearch } from '../shared/types.js';
import { gitlabPushLinkUrl, gitlabRepositoryUrl } from './gitlab-push.js';

export type GitlabReadObject = Record<string, unknown>;
export type GitlabReadStage = 'merge-requests' | 'pipelines' | 'project' | 'branches' | 'commits' | 'webhooks';
type GitlabReadErrorCode = 'http' | 'timeout' | 'network' | 'invalid-response' | 'response-too-large';
type Connection = { baseUrl: string; token?: string | null };
type ManualPage =
  | { repositoryPath: string; kind: 'merge_request' | 'pipeline'; id: number }
  | { repositoryPath: string; kind: 'branch' | 'commit'; id: string };
type RepositoryHistory = {
  project: GitlabReadObject;
  branches: GitlabReadObject[];
  commits: GitlabReadObject[];
  branchesLimited: boolean;
  commitsLimited: boolean;
};

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const MERGE_REQUEST_PAGE_SIZE = 100;
const MAX_MERGE_REQUEST_PAGES = 10;
const PIPELINE_PAGE_SIZE = 50;
const BRANCH_PAGE_SIZE = 100;
const MAX_BRANCH_PAGES = 5;
const COMMIT_PAGE_SIZE = 100;
const REPOSITORY_SEARCH_PAGE_SIZE = 20;
const WEBHOOK_PAGE_SIZE = 100;
const MAX_WEBHOOK_PAGES = 10;
const WEBHOOK_RECEIVER_PATH = '/api/integrations/gitlab/webhook';
export const GITLAB_REPOSITORY_SEARCH_MAX_PAGE = 20;

const stageNames: Record<GitlabReadStage, string> = {
  'merge-requests': 'MR',
  pipelines: '파이프라인',
  project: '저장소',
  branches: '브랜치',
  commits: '커밋',
  webhooks: '프로젝트 웹훅',
};

export class GitlabReadError extends Error {
  constructor(readonly stage: GitlabReadStage, readonly code: GitlabReadErrorCode, readonly httpStatus: number | null = null) {
    const description = {
      'http': `GitLab HTTP ${httpStatus} 응답`,
      'timeout': '응답 시간 초과',
      'network': '연결 실패',
      'invalid-response': '응답 형식 오류',
      'response-too-large': '응답 크기 한도 초과',
    }[code];
    super(`${stageNames[stage]} 조회 중 ${description}`);
  }
}

export class GitlabManualUrlError extends Error {
  readonly status = 400;
}

export class GitlabRepositoryQueryError extends Error {}

function isReadObject(value: unknown): value is GitlabReadObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(url: URL, headers: Record<string, string>, stage: GitlabReadStage, parentSignal?: AbortSignal,
  receiveHeaders?: (headers: Headers) => void, postBody?: GitlabReadObject): Promise<unknown> {
  const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = parentSignal ? AbortSignal.any([parentSignal, deadline]) : deadline;
  try {
    const request = postBody ? { method: 'POST', body: JSON.stringify(postBody), headers: { ...headers, 'Content-Type': 'application/json' } } : { headers };
    const response = await fetch(url, { ...request, signal, redirect: 'manual' });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new GitlabReadError(stage, 'http', response.status);
    }
    if (!response.body || (postBody && response.status !== 201)) {
      void response.body?.cancel().catch(() => {});
      throw new GitlabReadError(stage, 'invalid-response');
    }
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
      void response.body.cancel().catch(() => {});
      throw new GitlabReadError(stage, 'response-too-large');
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          void reader.cancel().catch(() => {});
          throw new GitlabReadError(stage, 'response-too-large');
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }

    try {
      const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
      receiveHeaders?.(response.headers);
      return data;
    }
    catch { throw new GitlabReadError(stage, 'invalid-response'); }
  } catch (error) {
    if (error instanceof GitlabReadError) throw error;
    throw new GitlabReadError(stage, signal.aborted ? 'timeout' : 'network');
  }
}

async function readPage(url: URL, headers: Record<string, string>, stage: GitlabReadStage, maxRows: number, signal?: AbortSignal,
  receiveHeaders?: (headers: Headers) => void): Promise<GitlabReadObject[]> {
  const payload = await readJson(url, headers, stage, signal, receiveHeaders);
  if (!Array.isArray(payload) || payload.length > maxRows || !payload.every(isReadObject)) {
    throw new GitlabReadError(stage, 'invalid-response');
  }
  return payload;
}

async function readRepositoryHistory(projectUrl: URL, projectId: number, headers: Record<string, string>, signal?: AbortSignal): Promise<RepositoryHistory> {
  const project = await readJson(projectUrl, headers, 'project', signal);
  if (!isReadObject(project) || project.id !== projectId) throw new GitlabReadError('project', 'invalid-response');

  const branchesUrl = new URL(projectUrl);
  branchesUrl.pathname += '/repository/branches';
  const branches: GitlabReadObject[] = [];
  for (let page = 1; page <= MAX_BRANCH_PAGES; page++) {
    branchesUrl.search = new URLSearchParams({ per_page: String(BRANCH_PAGE_SIZE), page: String(page) }).toString();
    const rows = await readPage(branchesUrl, headers, 'branches', BRANCH_PAGE_SIZE, signal);
    branches.push(...rows);
    if (rows.length < BRANCH_PAGE_SIZE) break;
  }

  const commitsUrl = new URL(projectUrl);
  commitsUrl.pathname += '/repository/commits';
  commitsUrl.search = new URLSearchParams({ all: 'true', per_page: String(COMMIT_PAGE_SIZE) }).toString();
  const commits = await readPage(commitsUrl, headers, 'commits', COMMIT_PAGE_SIZE, signal);
  return {
    project,
    branches,
    commits,
    branchesLimited: branches.length === MAX_BRANCH_PAGES * BRANCH_PAGE_SIZE,
    commitsLimited: commits.length === COMMIT_PAGE_SIZE,
  };
}

function projectsReadRequest({ baseUrl, token }: Connection, stage: GitlabReadStage) {
  let base: URL;
  try { base = new URL(baseUrl); }
  catch { throw new GitlabReadError(stage, 'network'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new GitlabReadError(stage, 'network');
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers['PRIVATE-TOKEN'] = token;
  const projectsUrl = new URL(base);
  projectsUrl.pathname = `${base.pathname.replace(/\/+$/, '')}/api/v4/projects`;
  return { base, headers, projectsUrl };
}

function projectReadRequest(connection: Connection, projectId: number, stage: GitlabReadStage) {
  if (!Number.isSafeInteger(projectId) || projectId < 1) throw new GitlabReadError(stage, 'network');
  const { base, headers, projectsUrl: projectUrl } = projectsReadRequest(connection, stage);
  projectUrl.pathname += `/${projectId}`;
  return { base, headers, projectUrl };
}

function invalidWebhookResponse(): never { throw new GitlabReadError('webhooks', 'invalid-response'); }

function webhookAddress(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 4000 || !value.isWellFormed() ||
      !/^https?:\/\//iu.test(value) || /[\u0000-\u0020\u007f\\]/u.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch { return null; }
}

function webhookReceiver(receiverUrl: string): string {
  const address = webhookAddress(receiverUrl);
  if (!address || address.protocol !== 'https:' || address.pathname !== WEBHOOK_RECEIVER_PATH ||
      address.username || address.password || receiverUrl.includes('?') || receiverUrl.includes('#')) {
    throw new GitlabReadError('webhooks', 'network');
  }
  return address.href;
}

function webhookIdentity(row: GitlabReadObject, projectId: number, requireProject: boolean) {
  const { id, url, project_id: actualProjectId } = row;
  const address = webhookAddress(url);
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || !address ||
      ((requireProject || actualProjectId !== undefined) && actualProjectId !== projectId)) invalidWebhookResponse();
  return { id, url: address.href };
}

function webhookFlags(row: GitlabReadObject, id: number): GitlabProjectWebhook {
  const { push_events: pushEvents, merge_requests_events: mergeRequestEvents, pipeline_events: pipelineEvents,
    enable_ssl_verification: sslVerification, push_events_branch_filter: filter, branch_filter_strategy: strategy,
    custom_webhook_template: template, alert_status: status } = row;
  if (typeof pushEvents !== 'boolean' || typeof mergeRequestEvents !== 'boolean' || typeof pipelineEvents !== 'boolean' ||
      typeof sslVerification !== 'boolean' || [filter, strategy, template, status].some(value => value != null && typeof value !== 'string')) {
    invalidWebhookResponse();
  }
  const active = status === 'executable' ? true : status === 'disabled' || status === 'temporarily_disabled' ? false : null;
  const unfilteredPush = strategy === 'all_branches' || ((strategy == null || strategy === 'wildcard') && (filter == null || filter === ''));
  return { id, pushEvents, mergeRequestEvents, pipelineEvents, sslVerification, unfilteredPush, standardPayload: template == null || template === '', active };
}

function webhookNextPage(headers: Headers, url: URL, page: number, rowCount: number): boolean {
  const next = headers.get('x-next-page');
  if (next !== null && next !== '' && next !== String(page + 1)) invalidWebhookResponse();
  let nextLink = false;
  const links = headers.get('link');
  if (links) for (const item of links.split(/,(?=\s*<)/u)) {
    const match = /^\s*<([^<>]+)>\s*;\s*rel\s*=\s*(?:"([^"<>]+)"|([\w-]+))\s*$/iu.exec(item);
    if (!match) invalidWebhookResponse();
    if (!(match[2] ?? match[3]).toLowerCase().split(/\s+/u).includes('next')) continue;
    if (nextLink) invalidWebhookResponse();
    let target: URL;
    try { target = new URL(match[1], url); }
    catch { invalidWebhookResponse(); }
    const perPage = target.searchParams.getAll('per_page');
    const pages = target.searchParams.getAll('page');
    if (target.origin !== url.origin || target.pathname !== url.pathname || target.username || target.password || target.hash ||
        pages.length !== 1 || pages[0] !== String(page + 1) || perPage.length > 1 || (perPage.length && perPage[0] !== String(WEBHOOK_PAGE_SIZE)) ||
        [...target.searchParams.keys()].some(key => key !== 'page' && key !== 'per_page')) invalidWebhookResponse();
    nextLink = true;
  }
  if ((next === '' && nextLink) || (rowCount === 0 && (Boolean(next) || nextLink))) invalidWebhookResponse();
  return next !== null ? next !== '' : nextLink || rowCount === WEBHOOK_PAGE_SIZE;
}

export async function listGitlabProjectWebhooks(connection: Connection, projectId: number, receiverUrl: string, signal?: AbortSignal): Promise<GitlabProjectWebhook[]> {
  const receiver = webhookReceiver(receiverUrl);
  const trusted = new URL(receiver);
  const { headers, projectUrl } = projectReadRequest(connection, projectId, 'webhooks');
  projectUrl.pathname += '/hooks';
  const hooks: GitlabProjectWebhook[] = [];
  const seen = new Set<number>();
  for (let page = 1; page <= MAX_WEBHOOK_PAGES; page++) {
    projectUrl.search = new URLSearchParams({ per_page: String(WEBHOOK_PAGE_SIZE), page: String(page) }).toString();
    let pagination = new Headers();
    const rows = await readPage(projectUrl, headers, 'webhooks', WEBHOOK_PAGE_SIZE, signal, value => { pagination = value; });
    for (const row of rows) {
      const identity = webhookIdentity(row, projectId, false);
      if (seen.has(identity.id)) invalidWebhookResponse();
      seen.add(identity.id);
      const address = new URL(identity.url);
      if (identity.url === receiver) hooks.push(webhookFlags(row, identity.id));
      else if (address.origin === trusted.origin && address.pathname.replace(/\/$/u, '') === trusted.pathname) {
        hooks.push({ ...webhookFlags(row, identity.id), receiverExact: false });
      }
    }
    if (!webhookNextPage(pagination, projectUrl, page, rows.length)) return hooks;
  }
  return invalidWebhookResponse();
}

export async function createGitlabProjectWebhook(connection: Connection, projectId: number, receiverUrl: string,
  credential: { mode: GitlabProjectWebhookAuthMode; value: string }, signal?: AbortSignal): Promise<GitlabProjectWebhook> {
  const receiver = webhookReceiver(receiverUrl);
  const { headers, projectUrl } = projectReadRequest(connection, projectId, 'webhooks');
  projectUrl.pathname += '/hooks';
  const { mode, value } = credential;
  if ((mode !== 'secret' && mode !== 'signature') || typeof value !== 'string' || !value || value.length > 2000 || /[\r\n]/u.test(value)) {
    throw new GitlabReadError('webhooks', 'network');
  }
  const response = await readJson(projectUrl, headers, 'webhooks', signal, undefined, {
    url: receiver, push_events: true, merge_requests_events: true, pipeline_events: true, enable_ssl_verification: true,
    [mode === 'signature' ? 'signing_token' : 'token']: value,
  });
  if (!isReadObject(response)) invalidWebhookResponse();
  const identity = webhookIdentity(response, projectId, true);
  if (identity.url !== receiver) invalidWebhookResponse();
  return webhookFlags(response, identity.id);
}

export async function supportsGitlabProjectWebhookSigning(connection: Connection, signal?: AbortSignal): Promise<boolean> {
  const { headers, projectsUrl } = projectsReadRequest(connection, 'webhooks');
  projectsUrl.pathname = projectsUrl.pathname.replace(/\/projects$/u, '/version');
  const response = await readJson(projectsUrl, headers, 'webhooks', signal);
  const match = isReadObject(response) && typeof response.version === 'string'
    ? /^(\d{1,4})\.(\d{1,4})\.\d{1,4}(?:$|[-+])/u.exec(response.version) : null;
  if (!match) return invalidWebhookResponse();
  const major = Number(match[1]);
  return major > 19 || (major === 19 && Number(match[2]) >= 1);
}

function canonicalPath(pathname: string): string | null {
  try {
    const path = pathname.replace(/\/$/, '');
    if (!path) return '';
    const segments = path.slice(1).split('/').map(segment => decodeURIComponent(segment));
    if (segments.some(segment => !segment || segment === '.' || segment === '..' || /[\u0000-\u001f\u007f/\\]/u.test(segment))) return null;
    return '/' + segments.map(segment => encodeURIComponent(segment)).join('/');
  } catch { return null; }
}

function gitlabPageAddress(raw: unknown, base: URL, allowSuffix: boolean) {
  if (typeof raw !== 'string' || raw.length > 4000 || !raw.isWellFormed()) return null;
  const text = raw.trim();
  if (/[\u0000-\u0020\u007f\\]/u.test(text)) return null;
  // Check the original path before URL parsing can resolve dot segments.
  const input = /^https?:\/\/[^/?#@]+(\/[^?#]*)?(?:[?#]|$)/iu.exec(text);
  if (!input?.[1]) return null;
  const scope = canonicalPath(base.pathname.replace(/\/+$/, '') + '/');
  if (scope === null) return null;
  try {
    const url = new URL(text);
    if (url.origin !== base.origin || url.username || url.password || (!allowSuffix && (text.includes('?') || text.includes('#')))) return null;
    return { pathname: input[1], scope, search: url.searchParams };
  } catch { return null; }
}

function gitlabPathInScope(pathname: string, scope: string) {
  const path = canonicalPath(pathname);
  return path && path.startsWith(`${scope}/`) ? path : null;
}

function searchedRepository(project: GitlabReadObject, base: URL): GitlabRepositoryCandidate {
  const { id, name, path_with_namespace: pathWithNamespace, web_url: rawWebUrl, archived } = project;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || typeof name !== 'string' ||
      !name.trim() || name.length > 512 || !name.isWellFormed() || /\p{Cc}/u.test(name) ||
      typeof pathWithNamespace !== 'string' || (archived !== undefined && typeof archived !== 'boolean')) {
    throw new GitlabReadError('project', 'invalid-response');
  }
  const canonical = gitlabRepositoryUrl(base.href, { path_with_namespace: pathWithNamespace });
  const address = gitlabPageAddress(rawWebUrl, base, false);
  const path = address && gitlabPathInScope(address.pathname, address.scope);
  if (!canonical || !path || path !== canonicalPath(canonical.pathname) || canonical.href.length > 4000) {
    throw new GitlabReadError('project', 'invalid-response');
  }
  return { id, name: name.trim(), pathWithNamespace, webUrl: canonical.href };
}

export async function readGitlabRepositorySearch(
  connection: Connection, query: string, page: number, signal?: AbortSignal,
): Promise<Pick<GitlabRepositorySearch, 'repositories' | 'hasNextPage'>> {
  const { base, headers, projectsUrl } = projectsReadRequest(connection, 'project');
  const exact = query.includes('/');
  let rows: GitlabReadObject[];
  let nextPage: string | null = null;
  let links: string | null = null;
  if (exact) {
    if (page !== 1 || !gitlabRepositoryUrl(base.href, { path_with_namespace: query })) {
      throw new GitlabRepositoryQueryError('저장소 경로는 그룹/저장소 형식으로 입력해 주세요.');
    }
    projectsUrl.pathname += `/${encodeURIComponent(query)}`;
    try {
      const project = await readJson(projectsUrl, headers, 'project', signal);
      if (!isReadObject(project) || project.path_with_namespace !== query) throw new GitlabReadError('project', 'invalid-response');
      rows = [project];
    } catch (error) {
      if (!(error instanceof GitlabReadError) || error.httpStatus !== 404) throw error;
      rows = [];
    }
  } else {
    projectsUrl.search = new URLSearchParams({ search: query, search_namespaces: 'true', simple: 'true', archived: 'false',
      order_by: 'id', sort: 'asc', per_page: String(REPOSITORY_SEARCH_PAGE_SIZE), page: String(page) }).toString();
    rows = await readPage(projectsUrl, headers, 'project', REPOSITORY_SEARCH_PAGE_SIZE, signal, responseHeaders => {
      nextPage = responseHeaders.get('x-next-page');
      links = responseHeaders.get('link');
    });
  }

  const ids = new Set<number>();
  const paths = new Set<string>();
  const repositories: GitlabRepositoryCandidate[] = [];
  const token = connection.token;
  const encodedToken = token ? encodeURIComponent(token) : '';
  for (const row of rows) {
    if (row.archived === true) continue;
    const repository = searchedRepository(row, base);
    if (ids.has(repository.id) || paths.has(repository.pathWithNamespace)) throw new GitlabReadError('project', 'invalid-response');
    ids.add(repository.id);
    paths.add(repository.pathWithNamespace);
    if (token && [repository.name, repository.pathWithNamespace, repository.webUrl].some(value =>
      value.includes(token) || value.includes(encodedToken))) continue;
    repositories.push(repository);
  }
  const reportedNext = nextPage !== null ? nextPage === String(page + 1)
    : links !== null ? /(?:^|;)\s*rel="?next"?(?=\s*[,;]|\s*$)/i.test(links) : rows.length === REPOSITORY_SEARCH_PAGE_SIZE;
  return { repositories, hasNextPage: !exact && page < GITLAB_REPOSITORY_SEARCH_MAX_PAGE && reportedNext };
}

function manualPage(raw: unknown, base: URL, allowSuffix: boolean): ManualPage | null {
  const address = gitlabPageAddress(raw, base, allowSuffix);
  if (!address) return null;
  const { pathname, scope, search } = address;
  // A branch ref may contain raw or encoded slashes. Canonicalize only the repository path first.
  for (const route of pathname.matchAll(/\/-\/(tree|commit)\//gu)) {
    const repositoryPath = gitlabPathInScope(pathname.slice(0, route.index), scope);
    if (!repositoryPath) continue;
    try {
      const ref = decodeURIComponent(pathname.slice(route.index + route[0].length));
      if (route[1] === 'tree') return isGitlabBranchName(ref) && search.getAll('ref_type').every(type => type === 'heads')
        ? { repositoryPath, kind: 'branch', id: ref } : null;
      const sha = gitlabObjectSha(ref);
      return sha && !/^0+$/.test(sha) ? { repositoryPath, kind: 'commit', id: sha } : null;
    } catch { return null; }
  }
  const path = gitlabPathInScope(pathname, scope);
  if (!path) return null;
  const match = /^(.+)\/(merge_requests|pipelines)\/([1-9]\d*)$/u.exec(path);
  if (!match || !Number.isSafeInteger(Number(match[3]))) return null;
  const repositoryPath = match[1].replace(/\/-$/u, '');
  const kind = match[2] === 'merge_requests' ? 'merge_request' : 'pipeline';
  return { repositoryPath, kind, id: Number(match[3]) };
}

export async function readGitlabManualObject(
  connection: Connection, projectId: number, rawUrl: unknown, signal?: AbortSignal,
  onResolvedBranch?: (name: string, webUrl: string) => void,
): Promise<{
  kind: ManualPage['kind'];
  object: GitlabReadObject;
  webUrl: string;
}> {
  const { base, headers, projectUrl } = projectReadRequest(connection, projectId, 'project');
  const page = manualPage(rawUrl, base, true);
  if (!page) throw new GitlabManualUrlError('설정한 GitLab의 브랜치·커밋·MR·파이프라인 주소를 입력해 주세요.');

  const project = await readJson(projectUrl, headers, 'project', signal);
  if (!isReadObject(project) || project.id !== projectId) throw new GitlabReadError('project', 'invalid-response');
  const address = gitlabPageAddress(project.web_url, base, false);
  const repositoryPath = address && gitlabPathInScope(address.pathname, address.scope);
  const namespace = project.path_with_namespace === undefined ? gitlabRepositoryUrl(connection.baseUrl, { web_url: project.web_url })
    : gitlabRepositoryUrl(connection.baseUrl, { path_with_namespace: project.path_with_namespace });
  if (!repositoryPath || !namespace || canonicalPath(namespace.pathname) !== repositoryPath) throw new GitlabReadError('project', 'invalid-response');
  if (page.repositoryPath !== repositoryPath) throw new GitlabManualUrlError('선택한 GitLab 저장소의 활동 주소를 입력해 주세요.');

  const itemUrl = new URL(projectUrl);
  if (page.kind === 'branch' || page.kind === 'commit') {
    const stage = page.kind === 'branch' ? 'branches' : 'commits';
    const webUrl = gitlabPushLinkUrl(namespace, page.kind === 'branch' ? 'tree' : 'commit', page.id);
    if (!webUrl) throw new GitlabManualUrlError('GitLab 활동 주소가 너무 깁니다.');
    itemUrl.pathname += `/repository/${stage}/${encodeURIComponent(page.id)}`;
    if (page.kind === 'branch') onResolvedBranch?.(page.id, webUrl);
    const object = await readJson(itemUrl, headers, stage, signal);
    if (!isReadObject(object) || object.project_id !== undefined && object.project_id !== projectId) {
      throw new GitlabReadError(stage, 'invalid-response');
    }
    const sourceId = page.kind === 'branch' ? (isReadObject(object.commit) ? object.commit.id : undefined) : object.id;
    const sha = gitlabObjectSha(sourceId);
    if (!sha || /^0+$/.test(sha) || (page.kind === 'branch' ? object.name !== page.id : sha !== page.id)) {
      throw new GitlabReadError(stage, 'invalid-response');
    }
    return { kind: page.kind, object: { ...object, web_url: webUrl }, webUrl };
  }
  const stage = page.kind === 'merge_request' ? 'merge-requests' : 'pipelines';
  const collection = page.kind === 'merge_request' ? 'merge_requests' : 'pipelines';
  itemUrl.pathname += `/${collection}/${page.id}`;
  const object = await readJson(itemUrl, headers, stage, signal);
  if (!isReadObject(object) || object.project_id !== projectId || typeof object.id !== 'number' ||
      !Number.isSafeInteger(object.id) || object.id < 1 ||
      (page.kind === 'merge_request' ? object.iid !== page.id || (object.target_project_id !== undefined && object.target_project_id !== projectId)
        : object.id !== page.id)) throw new GitlabReadError(stage, 'invalid-response');

  const verified = manualPage(object.web_url, base, false);
  if (!verified || verified.repositoryPath !== page.repositoryPath || verified.kind !== page.kind || verified.id !== page.id) {
    throw new GitlabReadError(stage, 'invalid-response');
  }
  const webUrl = new URL(`${repositoryPath}/-/${collection}/${page.id}`, base.origin).href;
  return { kind: page.kind, object: { ...object, web_url: webUrl }, webUrl };
}

export async function readGitlabSyncProject(
  connection: Connection, projectId: number, options: { signal?: AbortSignal; includeHistory?: boolean } = {},
): Promise<{ mergeRequests: GitlabReadObject[]; pipelines: GitlabReadObject[]; history?: RepositoryHistory }> {
  const { projectUrl, headers } = projectReadRequest(connection, projectId, 'merge-requests');
  const history = options.includeHistory ? await readRepositoryHistory(projectUrl, projectId, headers, options.signal) : undefined;
  const mergeRequestsUrl = new URL(projectUrl);
  mergeRequestsUrl.pathname += '/merge_requests';
  const mergeRequests: GitlabReadObject[] = [];
  for (let page = 1; page <= MAX_MERGE_REQUEST_PAGES; page++) {
    mergeRequestsUrl.search = new URLSearchParams({ scope: 'all', per_page: String(MERGE_REQUEST_PAGE_SIZE), page: String(page) }).toString();
    const rows = await readPage(mergeRequestsUrl, headers, 'merge-requests', MERGE_REQUEST_PAGE_SIZE, options.signal);
    mergeRequests.push(...rows);
    if (rows.length < MERGE_REQUEST_PAGE_SIZE) break;
  }
  const pipelinesUrl = new URL(projectUrl);
  pipelinesUrl.pathname += '/pipelines';
  pipelinesUrl.search = new URLSearchParams({ per_page: String(PIPELINE_PAGE_SIZE) }).toString();
  const pipelines = await readPage(pipelinesUrl, headers, 'pipelines', PIPELINE_PAGE_SIZE, options.signal);
  return { mergeRequests, pipelines, ...(history ? { history } : {}) };
}
