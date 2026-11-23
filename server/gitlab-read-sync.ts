import { isCalendarDate } from '../shared/calendar.js';
import { gitlabObjectSha, isGitlabBranchName } from '../shared/gitlab-links.js';
import type { GitlabProjectWebhook, GitlabProjectWebhookAttemptDetails, GitlabProjectWebhookAuthMode } from '../shared/gitlab-project-webhooks.js';
import type { GitlabIssueBranchTarget, GitlabMergeRequestReview, GitlabPipelineJob, GitlabPipelineJobs, GitlabRepositoryCandidate, GitlabRepositorySearch,
  GitlabReviewParticipant, GitlabReviewState } from '../shared/types.js';
import { gitlabPushLinkUrl, gitlabRepositoryUrl } from './gitlab-push.js';
import { gitlabWebhookMessageDigest } from './gitlab-webhook-message.js';

export type GitlabReadObject = Record<string, unknown>;
export type GitlabReadStage = 'merge-requests' | 'pipelines' | 'project' | 'branches' | 'commits' | 'webhooks' |
  'deployments' | 'deployment-merge-requests' | 'pipeline-jobs' | 'merge-request-review';
type GitlabReadErrorCode = 'http' | 'timeout' | 'network' | 'invalid-response' | 'response-too-large' | 'changed';
type Connection = { baseUrl: string; token?: string | null };
type ManualPage =
  | { repositoryPath: string; kind: 'merge_request' | 'pipeline'; id: number }
  | { repositoryPath: string; kind: 'branch' | 'commit'; id: string };
type WorkflowPage = Extract<ManualPage, { id: number }>;
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
const PIPELINE_JOB_PAGE_SIZE = 50;
const MAX_PIPELINE_JOB_PAGES = 4;
const MR_REVIEW_PARTICIPANT_LIMIT = 50;
const BRANCH_PAGE_SIZE = 100;
const MAX_BRANCH_PAGES = 5;
const COMMIT_PAGE_SIZE = 100;
const REPOSITORY_SEARCH_PAGE_SIZE = 20;
const WEBHOOK_PAGE_SIZE = 100;
const MAX_WEBHOOK_PAGES = 10;
const WEBHOOK_HISTORY_LIMIT = 20;
const WEBHOOK_RECEIVER_PATH = '/api/integrations/gitlab/webhook';
const WEBHOOK_ATTEMPT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;
const WEBHOOK_HISTORY_EVENTS = new Map<string, GitlabProjectWebhookAttemptDetails['event']>([
  ['push_hooks', 'push'], ['tag_push_hooks', 'tag_push'], ['merge_request_hooks', 'merge_request'],
  ['pipeline_hooks', 'pipeline'], ['deployment_hooks', 'deployment'],
]);
export const GITLAB_REPOSITORY_SEARCH_MAX_PAGE = 20;

const stageNames: Record<GitlabReadStage, string> = {
  'merge-requests': 'MR',
  pipelines: '파이프라인',
  project: '저장소',
  branches: '브랜치',
  commits: '커밋',
  webhooks: '프로젝트 웹훅',
  deployments: '배포',
  'deployment-merge-requests': '배포에 포함된 MR',
  'pipeline-jobs': '파이프라인 작업',
  'merge-request-review': 'MR 검토',
};

export class GitlabReadError extends Error {
  constructor(readonly stage: GitlabReadStage, readonly code: GitlabReadErrorCode, readonly httpStatus: number | null = null) {
    const description = {
      'http': `GitLab HTTP ${httpStatus} 응답`,
      'timeout': '응답 시간 초과',
      'network': '연결 실패',
      'invalid-response': '응답 형식 오류',
      'response-too-large': '응답 크기 한도 초과',
      'changed': stage === 'merge-request-review' ? 'MR이 변경되었습니다. 다시 확인해 주세요.' : '파이프라인이 변경되었습니다. 다시 확인해 주세요.',
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
    deployment_events: deploymentEvents,
    enable_ssl_verification: sslVerification, push_events_branch_filter: filter, branch_filter_strategy: strategy,
    custom_webhook_template: template, alert_status: status } = row;
  if (typeof pushEvents !== 'boolean' || typeof mergeRequestEvents !== 'boolean' || typeof pipelineEvents !== 'boolean' ||
      (deploymentEvents != null && typeof deploymentEvents !== 'boolean') ||
      typeof sslVerification !== 'boolean' || [filter, strategy, template, status].some(value => value != null && typeof value !== 'string')) {
    invalidWebhookResponse();
  }
  const active = status === 'executable' ? true : status === 'disabled' || status === 'temporarily_disabled' ? false : null;
  const unfilteredPush = strategy === 'all_branches' || ((strategy == null || strategy === 'wildcard') && (filter == null || filter === ''));
  return { id, pushEvents, mergeRequestEvents, pipelineEvents, deploymentEvents: deploymentEvents ?? null,
    sslVerification, unfilteredPush, standardPayload: template == null || template === '', active };
}

function webhookNextPage(headers: Headers, url: URL, page: number, pageSize: number, rowCount: number): boolean {
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
        pages.length !== 1 || pages[0] !== String(page + 1) || perPage.length > 1 || (perPage.length && perPage[0] !== String(pageSize)) ||
        [...target.searchParams.keys()].some(key => key !== 'page' && key !== 'per_page')) invalidWebhookResponse();
    nextLink = true;
  }
  if ((next === '' && nextLink) || (rowCount === 0 && (Boolean(next) || nextLink))) invalidWebhookResponse();
  return next !== null ? next !== '' : nextLink || rowCount === pageSize;
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
    if (!webhookNextPage(pagination, projectUrl, page, WEBHOOK_PAGE_SIZE, rows.length)) return hooks;
  }
  return invalidWebhookResponse();
}

function webhookAttemptStatus(value: unknown): number | null | undefined {
  if (value === 0 || value === '0' || value === 'internal error') return null;
  const status = typeof value === 'string' && /^[1-5]\d{2}$/u.test(value) ? Number(value) : value;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) return status;
}

function webhookAttemptTime(value: unknown): string | null {
  if (typeof value !== 'string' || !WEBHOOK_ATTEMPT_TIMESTAMP.test(value) || !isCalendarDate(value.slice(0, 10))) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const canonical = new Date(time).toISOString();
  return canonical.length === 24 ? canonical : null;
}

export async function readGitlabProjectWebhookHistory(connection: Connection, repositoryId: number, hookId: number,
  receiverUrl: string, signal?: AbortSignal): Promise<{ attempts: GitlabProjectWebhookAttemptDetails[]; partial: boolean; messageDigests: Map<number, string> }> {
  const receiver = webhookReceiver(receiverUrl);
  if (!Number.isSafeInteger(hookId) || hookId < 1) throw new GitlabReadError('webhooks', 'network');
  const { headers, projectUrl } = projectReadRequest(connection, repositoryId, 'webhooks');
  projectUrl.pathname += `/hooks/${hookId}/events`;
  projectUrl.search = new URLSearchParams({ per_page: String(WEBHOOK_HISTORY_LIMIT), page: '1' }).toString();
  let pagination = new Headers();
  const rows = await readJson(projectUrl, headers, 'webhooks', signal, value => { pagination = value; });
  if (!Array.isArray(rows) || rows.length > WEBHOOK_HISTORY_LIMIT) invalidWebhookResponse();
  let partial = webhookNextPage(pagination, projectUrl, 1, WEBHOOK_HISTORY_LIMIT, rows.length);
  const attempts = new Map<number, GitlabProjectWebhookAttemptDetails>();
  const messageDigests = new Map<number, string>();
  const seen = new Set<number>();
  for (const row of rows) {
    if (!isReadObject(row) || typeof row.id !== 'number' || !Number.isSafeInteger(row.id) || row.id < 1) {
      partial = true;
      continue;
    }
    const { id } = row;
    if (seen.has(id)) {
      attempts.delete(id);
      messageDigests.delete(id);
      partial = true;
      continue;
    }
    seen.add(id);
    const status = webhookAttemptStatus(row.response_status);
    if (webhookAddress(row.url)?.href !== receiver || status === undefined) {
      partial = true;
      continue;
    }
    const event = typeof row.trigger === 'string' ? WEBHOOK_HISTORY_EVENTS.get(row.trigger) ?? 'other' : 'other';
    const seconds = row.execution_duration;
    const duration = typeof seconds === 'number' && seconds >= 0 ? Math.round(seconds * 1000) : NaN;
    attempts.set(id, { id, event, status, sentAt: webhookAttemptTime(row.created_at),
      durationMs: Number.isSafeInteger(duration) ? duration : null });
    const messageDigest = event === 'other' ? null : gitlabWebhookMessageDigest(row.request_headers);
    if (messageDigest) messageDigests.set(id, messageDigest);
  }
  return { attempts: [...attempts.values()], partial, messageDigests };
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
    url: receiver, push_events: true, merge_requests_events: true, pipeline_events: true, deployment_events: true,
    enable_ssl_verification: true,
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

function verifiedProjectRepository(project: unknown, projectId: number, base: URL) {
  if (!isReadObject(project) || project.id !== projectId) throw new GitlabReadError('project', 'invalid-response');
  const address = gitlabPageAddress(project.web_url, base, false);
  const repositoryPath = address && gitlabPathInScope(address.pathname, address.scope);
  const repository = project.path_with_namespace === undefined ? gitlabRepositoryUrl(base.href, { web_url: project.web_url })
    : gitlabRepositoryUrl(base.href, { path_with_namespace: project.path_with_namespace });
  if (!repositoryPath || !repository || canonicalPath(repository.pathname) !== repositoryPath) {
    throw new GitlabReadError('project', 'invalid-response');
  }
  return { project, repositoryPath, repository };
}

async function readVerifiedProject(connection: Connection, repositoryId: number, signal?: AbortSignal) {
  const request = projectReadRequest(connection, repositoryId, 'project');
  const project = await readJson(request.projectUrl, request.headers, 'project', signal);
  return { ...request, ...verifiedProjectRepository(project, repositoryId, request.base) };
}

function verifiedBranch(value: unknown, repositoryId: number, branch: string) {
  if (!isReadObject(value) || value.name !== branch ||
      (value.project_id !== undefined && value.project_id !== repositoryId) || !isReadObject(value.commit)) {
    throw new GitlabReadError('branches', 'invalid-response');
  }
  const sha = gitlabObjectSha(value.commit.id);
  if (!sha || /^0+$/u.test(sha)) throw new GitlabReadError('branches', 'invalid-response');
  return { object: value, sourceSha: sha };
}

async function readBranchDetails({ projectUrl, headers }: ReturnType<typeof projectReadRequest>, repositoryId: number,
  name: string, signal?: AbortSignal) {
  const url = new URL(projectUrl);
  url.pathname += `/repository/branches/${encodeURIComponent(name)}`;
  const object = await readJson(url, headers, 'branches', signal);
  return verifiedBranch(object, repositoryId, name);
}

async function readExactBranch(request: ReturnType<typeof projectReadRequest>, repositoryId: number, branch: string,
  signal?: AbortSignal): Promise<string | null> {
  if (!isGitlabBranchName(branch)) throw new GitlabReadError('branches', 'invalid-response');
  try {
    return (await readBranchDetails(request, repositoryId, branch, signal)).sourceSha;
  } catch (error) {
    if (error instanceof GitlabReadError && error.httpStatus === 404) return null;
    throw error;
  }
}

async function readExactCommit({ projectUrl, headers }: ReturnType<typeof projectReadRequest>, repositoryId: number,
  sha: string, signal?: AbortSignal): Promise<string> {
  const url = new URL(projectUrl);
  url.pathname += `/repository/commits/${sha}`;
  const value = await readJson(url, headers, 'commits', signal);
  if (!isReadObject(value) || gitlabObjectSha(value.id) !== sha ||
      (value.project_id !== undefined && value.project_id !== repositoryId)) {
    throw new GitlabReadError('commits', 'invalid-response');
  }
  return sha;
}

function includesGitlabCredential(token: string | null | undefined, values: readonly string[]) {
  if (!token) return false;
  if (!token.isWellFormed()) return true;
  const encoded = encodeURIComponent(token);
  return values.some(value => value.includes(token) || value.includes(encoded));
}

export async function readGitlabBranchTarget(connection: Connection, repositoryId: number, branch: string,
  ref: string | undefined, signal?: AbortSignal): Promise<{ target: GitlabIssueBranchTarget; existingSha?: string }> {
  if (!isGitlabBranchName(branch)) throw new GitlabReadError('branches', 'invalid-response');
  const project = await readVerifiedProject(connection, repositoryId, signal);
  const sourceRef = ref ?? project.project.default_branch;
  if (!isGitlabBranchName(sourceRef)) throw new GitlabReadError('branches', 'invalid-response');
  const commit = ref === undefined ? null : gitlabObjectSha(sourceRef);
  if (commit && /^0+$/u.test(commit)) throw new GitlabReadError('commits', 'invalid-response');
  const webUrl = gitlabPushLinkUrl(project.repository, 'tree', branch);
  const basePath = project.base.pathname.replace(/\/+$/u, '');
  const repositoryPath = decodeURIComponent(project.repository.pathname.slice(basePath.length + 1));
  if (!webUrl || includesGitlabCredential(connection.token, [branch, sourceRef, repositoryPath, webUrl])) {
    throw new GitlabReadError('branches', 'invalid-response');
  }
  const sourceRead = commit
    ? readExactCommit(project, repositoryId, commit, signal)
    : readExactBranch(project, repositoryId, sourceRef, signal);
  const targetRead = !commit && branch === sourceRef ? sourceRead : readExactBranch(project, repositoryId, branch, signal);
  const [sourceSha, existingSha] = await Promise.all([sourceRead, targetRead]);
  if (!sourceSha) throw new GitlabReadError('branches', 'http', 404);
  if (includesGitlabCredential(connection.token, [sourceSha, existingSha ?? ''])) throw new GitlabReadError('branches', 'invalid-response');
  const target: GitlabIssueBranchTarget = { repositoryId, repositoryPath, branch, ref: sourceRef, sourceSha, webUrl };
  return { target, ...(existingSha && { existingSha }) };
}

export async function readGitlabBranchHead(connection: Connection, repositoryId: number, branch: string,
  signal?: AbortSignal): Promise<string | null> {
  if (!isGitlabBranchName(branch) || includesGitlabCredential(connection.token, [branch])) {
    throw new GitlabReadError('branches', 'invalid-response');
  }
  const project = await readVerifiedProject(connection, repositoryId, signal);
  const sha = await readExactBranch(project, repositoryId, branch, signal);
  if (sha && includesGitlabCredential(connection.token, [sha])) throw new GitlabReadError('branches', 'invalid-response');
  return sha;
}

export async function createGitlabIssueBranch(connection: Connection, repositoryId: number, branch: string,
  sourceSha: string): Promise<string> {
  const sha = gitlabObjectSha(sourceSha);
  if (!connection.token?.trim() || !isGitlabBranchName(branch) || !sha || /^0+$/u.test(sha) ||
      includesGitlabCredential(connection.token, [branch, sha])) throw new GitlabReadError('branches', 'invalid-response');
  const { headers, projectUrl } = projectReadRequest(connection, repositoryId, 'branches');
  projectUrl.pathname += '/repository/branches';
  const value = await readJson(projectUrl, headers, 'branches', undefined, undefined, { branch, ref: sha });
  const { sourceSha: createdSha } = verifiedBranch(value, repositoryId, branch);
  if (createdSha !== sha) throw new GitlabReadError('branches', 'invalid-response');
  return createdSha;
}

export function createGitlabDeploymentReader(connection: Connection, projectId: number, signal?: AbortSignal) {
  const { base, headers, projectUrl } = projectReadRequest(connection, projectId, 'project');

  async function list(suffix: string, query: URLSearchParams, stage: 'deployments' | 'deployment-merge-requests', pageSize: number) {
    const url = new URL(projectUrl);
    url.pathname += suffix;
    url.search = query.toString();
    let pagination = new Headers();
    const rows = await readPage(url, headers, stage, pageSize, signal, received => { pagination = received; });
    return { rows, pagination };
  }

  return {
    async repository() {
      const project = await readJson(projectUrl, headers, 'project', signal);
      return verifiedProjectRepository(project, projectId, base).repository;
    },
    deployments(pageSize: number) {
      return list('/deployments', new URLSearchParams({ order_by: 'id', sort: 'desc', per_page: String(pageSize), page: '1' }),
        'deployments', pageSize);
    },
    mergeRequests(deploymentId: number, pageSize: number, page: number) {
      if (!Number.isSafeInteger(deploymentId) || deploymentId < 1) throw new GitlabReadError('deployment-merge-requests', 'invalid-response');
      return list(`/deployments/${deploymentId}/merge_requests`,
        new URLSearchParams({ scope: 'all', state: 'merged', per_page: String(pageSize), page: String(page) }),
        'deployment-merge-requests', pageSize);
    },
  };
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

function isWorkflowPage(page: ManualPage): page is WorkflowPage {
  return typeof page.id === 'number';
}

export function isExactGitlabPipelineListRow(object: GitlabReadObject, projectId: number, baseUrl: string): boolean {
  if (object.project_id !== projectId) return false;
  const page = manualPage(object.web_url, new URL(baseUrl), false);
  return page?.kind === 'pipeline' && page.id === object.id;
}

async function readExactWorkflowObject(
  { base, headers, projectUrl }: ReturnType<typeof projectReadRequest>, projectId: number,
  { repositoryPath, kind, id }: WorkflowPage, signal?: AbortSignal,
): Promise<{ kind: WorkflowPage['kind']; object: GitlabReadObject; webUrl: string }> {
  const stage = kind === 'merge_request' ? 'merge-requests' : 'pipelines';
  const collection = kind === 'merge_request' ? 'merge_requests' : 'pipelines';
  const itemUrl = new URL(projectUrl);
  itemUrl.pathname += `/${collection}/${id}`;
  const object = await readJson(itemUrl, headers, stage, signal);
  if (!isReadObject(object) || object.project_id !== projectId || typeof object.id !== 'number' ||
      !Number.isSafeInteger(object.id) || object.id < 1 ||
      (kind === 'merge_request' ? object.iid !== id || (object.target_project_id !== undefined && object.target_project_id !== projectId)
        : object.id !== id)) throw new GitlabReadError(stage, 'invalid-response');

  const verified = manualPage(object.web_url, base, false);
  if (!verified || verified.repositoryPath !== repositoryPath || verified.kind !== kind || verified.id !== id) {
    throw new GitlabReadError(stage, 'invalid-response');
  }
  const webUrl = new URL(`${repositoryPath}/-/${collection}/${id}`, base.origin).href;
  return { kind, object: { ...object, web_url: webUrl }, webUrl };
}

export function gitlabLinkedActivityReader(connection: Connection, signal?: AbortSignal) {
  const projects = new Map<number, ReturnType<typeof readVerifiedProject>>();
  function projectFor(projectId: number) {
    let project = projects.get(projectId);
    if (!project) {
      project = readVerifiedProject(connection, projectId, signal);
      projects.set(projectId, project);
    }
    return project;
  }
  return {
    async workflow(projectId: number, kind: WorkflowPage['kind'], id: number, expectedObjectId: number) {
      const context = await projectFor(projectId);
      const verified = await readExactWorkflowObject(context, projectId, { repositoryPath: context.repositoryPath, kind, id }, signal);
      if (verified.object.id !== expectedObjectId || includesGitlabCredential(connection.token, [verified.webUrl])) {
        throw new GitlabReadError(kind === 'merge_request' ? 'merge-requests' : 'pipelines', 'invalid-response');
      }
      return verified;
    },
    async branch(projectId: number, name: string) {
      if (!isGitlabBranchName(name) || includesGitlabCredential(connection.token, [name])) {
        throw new GitlabReadError('branches', 'invalid-response');
      }
      const context = await projectFor(projectId);
      const webUrl = gitlabPushLinkUrl(context.repository, 'tree', name);
      if (!webUrl || includesGitlabCredential(connection.token, [webUrl])) throw new GitlabReadError('branches', 'invalid-response');
      const { sourceSha } = await readBranchDetails(context, projectId, name, signal);
      if (includesGitlabCredential(connection.token, [sourceSha])) throw new GitlabReadError('branches', 'invalid-response');
      return { sourceSha, webUrl };
    },
  };
}

const reviewStates = new Set<unknown>(['unreviewed', 'review_started', 'reviewed', 'requested_changes', 'approved', 'unapproved']);
const unavailableReviewStatuses = new Set([401, 403, 404, 405, 501]);
const reviewStage = 'merge-request-review';
const positiveId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const nonNegativeCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function invalidMergeRequestReview(): never {
  throw new GitlabReadError(reviewStage, 'invalid-response');
}

function reviewParticipants<T extends GitlabReviewParticipant>(rows: unknown, parse: (entry: GitlabReadObject) => T) {
  if (!Array.isArray(rows)) invalidMergeRequestReview();
  const ids = new Set<number>();
  return rows.slice(0, MR_REVIEW_PARTICIPANT_LIMIT).map(row => {
    if (!isReadObject(row)) invalidMergeRequestReview();
    const participant = parse(row);
    if (ids.has(participant.id)) invalidMergeRequestReview();
    ids.add(participant.id);
    return participant;
  });
}

function reviewParticipant(row: unknown, token: Connection['token']): GitlabReviewParticipant {
  if (!isReadObject(row) || !positiveId(row.id) || typeof row.username !== 'string' ||
      !/^[a-z\d_.-]{1,255}$/iu.test(row.username) || includesGitlabCredential(token, [row.username])) invalidMergeRequestReview();
  const name = typeof row.name === 'string' ? gitlabDisplayLabel(row.name, 255, token, row.username) : row.username;
  return { id: row.id, name, username: row.username };
}

function reviewRevision(object: GitlabReadObject): string {
  const { sha, diff_refs: refs, updated_at: updatedAt, state, reviewers } = object;
  const diffHead = isReadObject(refs) ? refs.head_sha : null;
  const head = gitlabObjectSha(sha), diff = gitlabObjectSha(diffHead);
  const time = typeof updatedAt === 'string' ? Date.parse(updatedAt) : NaN;
  if ((sha != null && !head) || (diffHead != null && !diff) || (updatedAt != null && !Number.isFinite(time))) invalidMergeRequestReview();
  const assigned = Array.isArray(reviewers) ? reviewers.flatMap(row => isReadObject(row) && positiveId(row.id) ? [row.id] : []).sort((a, b) => a - b) : null;
  return JSON.stringify([head, diff, Number.isFinite(time) ? time : null, state, assigned]);
}

export async function readGitlabMergeRequestReview(connection: Connection, repositoryId: number, iid: number, objectId: number,
  signal?: AbortSignal): Promise<Omit<GitlabMergeRequestReview, 'linkId' | 'repositoryId' | 'mergeRequestIid' | 'checkedAt'>> {
  if (!positiveId(iid) || !positiveId(objectId)) invalidMergeRequestReview();
  const { workflow } = gitlabLinkedActivityReader(connection, signal);
  const { object } = await workflow(repositoryId, 'merge_request', iid, objectId);
  const observed = reviewRevision(object);
  const { projectUrl, headers } = projectReadRequest(connection, repositoryId, reviewStage);
  const token = connection.token;
  async function readReviewPart(part: 'reviewers' | 'approvals', onHeaders?: (headers: Headers) => void) {
    const url = new URL(projectUrl);
    url.pathname += `/merge_requests/${iid}/${part}`;
    if (part === 'reviewers') url.search = new URLSearchParams({ per_page: String(MR_REVIEW_PARTICIPANT_LIMIT), page: '1' }).toString();
    try {
      return { available: true as const, payload: await readJson(url, headers, reviewStage, signal, onHeaders) };
    } catch (error) {
      if (error instanceof GitlabReadError && error.code === 'http' && unavailableReviewStatuses.has(error.httpStatus ?? 0)) {
        return { available: false as const };
      }
      throw error;
    }
  }
  let pagination = new Headers();
  const [roster, votes] = await Promise.all([readReviewPart('reviewers', value => { pagination = value; }), readReviewPart('approvals')]);
  const { object: latest } = await workflow(repositoryId, 'merge_request', iid, objectId);
  if (reviewRevision(latest) !== observed) throw new GitlabReadError(reviewStage, 'changed');

  const reviewerSource = roster.available ? 'reviewers' : Array.isArray(latest.reviewers) ? 'merge_request' : 'unavailable';
  const rows = roster.available ? roster.payload : reviewerSource === 'merge_request' ? latest.reviewers : [];
  const reviewers = reviewParticipants(rows, row => {
    const state = (roster.available && reviewStates.has(row.state) ? row.state : 'unknown') as GitlabReviewState;
    return { ...reviewParticipant(roster.available ? row.user : row, token), state };
  });
  const next = pagination.get('x-next-page'), links = pagination.get('link');
  const hasNext = next?.trim() === '2' || /(?:^|,)\s*<[^>]+>\s*;\s*rel\s*=\s*(?:"next"|next)(?=\s*(?:[;,]|$))/iu.test(links ?? '');
  const reviewersHasMore = hasNext || (Array.isArray(rows) && (rows.length > MR_REVIEW_PARTICIPANT_LIMIT ||
    (roster.available && next === null && links === null && rows.length === MR_REVIEW_PARTICIPANT_LIMIT)));

  if (!votes.available) return { reviewerSource, reviewers, reviewersHasMore, approvals: null };
  const payload = votes.payload;
  if (!isReadObject(payload) || (payload.project_id !== undefined && payload.project_id !== repositoryId) ||
      (payload.id !== undefined && payload.id !== objectId) || (payload.iid !== undefined && payload.iid !== iid)) invalidMergeRequestReview();
  const approvers = reviewParticipants(payload.approved_by, row => reviewParticipant(row.user, token));
  const { approvals_required: required, approvals_left: remaining } = payload;
  const approvals = nonNegativeCount(required) && nonNegativeCount(remaining) && remaining <= required
    ? { required, remaining } : { required: null, remaining: null };
  return { reviewerSource, reviewers, reviewersHasMore, approvals: { ...approvals, approvers,
    hasMore: Array.isArray(payload.approved_by) && payload.approved_by.length > MR_REVIEW_PARTICIPANT_LIMIT } };
}

function invalidPipelineJobs(): never {
  throw new GitlabReadError('pipeline-jobs', 'invalid-response');
}

function pipelineJobsNextPage(headers: Headers, url: URL, page: number, rowCount: number): boolean {
  const next = headers.get('x-next-page');
  if (next !== null && next !== '' && next !== String(page + 1)) invalidPipelineJobs();
  const links = headers.get('link');
  let nextLink = false;
  if (links) for (const item of links.split(/,(?=\s*<)/u)) {
    const match = /^\s*<([^<>]+)>\s*;\s*rel\s*=\s*(?:"([^"<>]+)"|([\w-]+))\s*$/iu.exec(item);
    if (!match) invalidPipelineJobs();
    if (!(match[2] ?? match[3]).toLowerCase().split(/\s+/u).includes('next')) continue;
    if (nextLink) invalidPipelineJobs();
    let target: URL;
    try { target = new URL(match[1], url); }
    catch { return invalidPipelineJobs(); }
    const pages = target.searchParams.getAll('page');
    if (target.origin !== url.origin || target.pathname !== url.pathname || target.username || target.password || target.hash ||
      pages.length !== 1 || pages[0] !== String(page + 1)) invalidPipelineJobs();
    nextLink = true;
  }
  const reportedNext = next !== null ? next !== '' : links !== null ? nextLink : rowCount === PIPELINE_JOB_PAGE_SIZE;
  if ((next === '' && nextLink) || (rowCount === 0 && reportedNext)) invalidPipelineJobs();
  return reportedNext;
}

function gitlabDisplayLabel(value: string, limit: number, token: string | null | undefined, fallback: string): string {
  const label = value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, limit).toWellFormed();
  return label && !includesGitlabCredential(token, [value, label]) ? label : fallback;
}

function pipelineJob(row: GitlabReadObject, repository: { id: number; path: string; base: URL },
  pipeline: { id: number; sha: string }, token: string | null | undefined): GitlabPipelineJob {
  const { id, name, stage, status, allow_failure: allowFailure, failure_reason: reason } = row;
  const source = row.pipeline;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 ||
    typeof name !== 'string' || !name.trim() || typeof stage !== 'string' || !stage.trim() ||
    (status !== 'failed' && status !== 'manual') || typeof allowFailure !== 'boolean' ||
    !isReadObject(source) || source.id !== pipeline.id || source.project_id !== repository.id ||
    (source.sha != null && gitlabObjectSha(source.sha) !== pipeline.sha)) invalidPipelineJobs();
  const address = gitlabPageAddress(row.web_url, repository.base, false);
  const path = address && gitlabPathInScope(address.pathname, address.scope);
  const canonicalPath = `${repository.path}/-/jobs/${id}`;
  if (path !== canonicalPath && path !== `${repository.path}/jobs/${id}`) invalidPipelineJobs();
  const webUrl = new URL(canonicalPath, repository.base.origin).href;
  if (includesGitlabCredential(token, [webUrl])) invalidPipelineJobs();
  const failureReason = status === 'failed' && typeof reason === 'string' && /^[a-z][a-z0-9_]{0,79}$/u.test(reason) &&
    !includesGitlabCredential(token, [reason]) ? reason : null;
  return { id, name: gitlabDisplayLabel(name, 255, token, '이름 미확인'), stage: gitlabDisplayLabel(stage, 128, token, '단계 미확인'),
    status, failureReason, allowFailure, webUrl };
}

export async function readGitlabPipelineJobs(connection: Connection, repositoryId: number, pipelineId: number,
  expectedSha: string | null, signal?: AbortSignal): Promise<Pick<GitlabPipelineJobs, 'status' | 'configurationError' | 'jobs' | 'hasMore'>> {
  if (!Number.isSafeInteger(pipelineId) || pipelineId < 1) invalidPipelineJobs();
  const context = await readVerifiedProject(connection, repositoryId, signal);
  async function readPipeline() {
    const { object, webUrl } = await readExactWorkflowObject(context, repositoryId,
      { repositoryPath: context.repositoryPath, kind: 'pipeline', id: pipelineId }, signal);
    const { status, updated_at: updated, yaml_errors: yamlErrors } = object;
    const sha = gitlabObjectSha(object.sha);
    if (!sha || /^0+$/u.test(sha) || typeof status !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/u.test(status) ||
      (updated != null && (typeof updated !== 'string' || !Number.isFinite(Date.parse(updated)))) ||
      (yamlErrors != null && typeof yamlErrors !== 'string') || includesGitlabCredential(connection.token, [webUrl, status])) invalidPipelineJobs();
    return { status, sha, updatedAt: typeof updated === 'string' ? updated : null,
      configurationError: typeof yamlErrors === 'string' && Boolean(yamlErrors.trim()) };
  }
  const observed = await readPipeline();
  if (expectedSha !== null && observed.sha !== gitlabObjectSha(expectedSha)) invalidPipelineJobs();
  const repository = { id: repositoryId, path: context.repositoryPath, base: context.base };
  const pipeline = { id: pipelineId, sha: observed.sha };
  const jobsUrl = new URL(context.projectUrl);
  jobsUrl.pathname += `/pipelines/${pipelineId}/jobs`;
  const jobs: GitlabPipelineJob[] = [];
  const seen = new Set<number>();
  let hasMore = false;
  for (let page = 1; page <= MAX_PIPELINE_JOB_PAGES; page++) {
    jobsUrl.search = new URLSearchParams([['scope[]', 'failed'], ['scope[]', 'manual'], ['include_retried', 'false'],
      ['per_page', String(PIPELINE_JOB_PAGE_SIZE)], ['page', String(page)]]).toString();
    let pagination = new Headers();
    const rows = await readPage(jobsUrl, context.headers, 'pipeline-jobs', PIPELINE_JOB_PAGE_SIZE, signal, headers => { pagination = headers; });
    for (const row of rows) {
      const job = pipelineJob(row, repository, pipeline, connection.token);
      if (seen.has(job.id)) invalidPipelineJobs();
      seen.add(job.id);
      jobs.push(job);
    }
    hasMore = pipelineJobsNextPage(pagination, jobsUrl, page, rows.length);
    if (!hasMore) break;
  }
  const latest = await readPipeline();
  if (latest.sha !== observed.sha || latest.status !== observed.status || latest.updatedAt !== observed.updatedAt ||
      latest.configurationError !== observed.configurationError) throw new GitlabReadError('pipeline-jobs', 'changed');
  return { status: observed.status, configurationError: observed.configurationError, jobs, hasMore };
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
  const { repositoryPath, repository } = verifiedProjectRepository(project, projectId, base);
  if (page.repositoryPath !== repositoryPath) throw new GitlabManualUrlError('선택한 GitLab 저장소의 활동 주소를 입력해 주세요.');

  if (!isWorkflowPage(page)) {
    const webUrl = gitlabPushLinkUrl(repository, page.kind === 'branch' ? 'tree' : 'commit', page.id);
    if (!webUrl) throw new GitlabManualUrlError('GitLab 활동 주소가 너무 깁니다.');
    if (page.kind === 'branch') {
      onResolvedBranch?.(page.id, webUrl);
      const { object } = await readBranchDetails({ base, headers, projectUrl }, projectId, page.id, signal);
      return { kind: page.kind, object: { ...object, web_url: webUrl }, webUrl };
    }
    const itemUrl = new URL(projectUrl);
    const stage = 'commits';
    itemUrl.pathname += `/repository/commits/${encodeURIComponent(page.id)}`;
    const object = await readJson(itemUrl, headers, stage, signal);
    if (!isReadObject(object) || object.project_id !== undefined && object.project_id !== projectId) {
      throw new GitlabReadError(stage, 'invalid-response');
    }
    if (gitlabObjectSha(object.id) !== page.id) {
      throw new GitlabReadError(stage, 'invalid-response');
    }
    return { kind: page.kind, object: { ...object, web_url: webUrl }, webUrl };
  }
  return readExactWorkflowObject({ base, headers, projectUrl }, projectId, page, signal);
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
