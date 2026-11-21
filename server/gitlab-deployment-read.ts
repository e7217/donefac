import { gitlabObjectSha } from '../shared/gitlab-links.js';
import { GITLAB_DEPLOYMENT_STATES, type GitlabDeployment, type GitlabDeploymentMergeRequest, type GitlabDeploymentState } from '../shared/types.js';
import { gitlabDeploymentTime } from './gitlab-deployments.js';
import { gitlabScopedPushUrl } from './gitlab-push.js';
import { createGitlabDeploymentReader, GitlabReadError, type GitlabReadObject } from './gitlab-read-sync.js';

const DEPLOYMENT_LIMIT = 50;
const MERGE_REQUEST_PAGE_SIZE = 100;
const MERGE_REQUEST_PAGE_LIMIT = 2;
const MERGE_REQUEST_CONCURRENCY = 4;
const READ_BUDGET_MS = 25_000;
const states: ReadonlySet<unknown> = new Set(GITLAB_DEPLOYMENT_STATES);

type Connection = { baseUrl: string; token?: string | null };
type Deployment = Omit<GitlabDeployment, 'instance'>;
type Reader = ReturnType<typeof createGitlabDeploymentReader>;
type AssociationResult = { mergeRequests: GitlabDeploymentMergeRequest[]; unavailable: boolean; limited: boolean; rateLimited: boolean };

export interface GitlabDeploymentHistory {
  deployments: Deployment[];
  scanned: number;
  deploymentLimitReached: boolean;
  associationUnavailable: number;
  associationLimited: number;
}

function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function label(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && value.trim() === value &&
    value.isWellFormed() && !/\p{Cc}/u.test(value);
}

function object(value: unknown): GitlabReadObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as GitlabReadObject : undefined;
}

function includesCredential(value: string, token?: string | null): boolean {
  return Boolean(token && (value.includes(token) || value.includes(encodeURIComponent(token))));
}

function canonicalJobUrl(raw: unknown, repoUrl: string, repositoryId: number, connection: Connection): string | undefined {
  const job = object(raw);
  if (!job || !positiveId(job.id)) return;
  const projectIds = [job.project_id, object(job.project)?.id, object(job.pipeline)?.project_id];
  if (projectIds.some(id => id != null && id !== repositoryId)) return;
  const url = `${repoUrl}/-/jobs/${job.id}`;
  if (url.length > 4_000 || includesCredential(url, connection.token)) return;
  if (job.web_url != null && gitlabScopedPushUrl(connection.baseUrl, job.web_url) !== url) return;
  return url;
}

function parseDeployment(row: GitlabReadObject, repositoryId: number, projectUrl: string, connection: Connection): Deployment {
  const { id, status, environment: environmentRaw, project_id: projectId } = row;
  const sha = gitlabObjectSha(row.sha);
  const changedAt = gitlabDeploymentTime(row.updated_at);
  const environment = object(environmentRaw)?.name;
  const environmentTier = object(environmentRaw)?.tier ?? undefined;
  if (!positiveId(id) || !states.has(status) || !sha || /^0+$/u.test(sha) || !changedAt || !label(environment, 255) ||
      (projectId != null && projectId !== repositoryId) || (environmentTier !== undefined && !label(environmentTier, 64)) ||
      [sha, environment, environmentTier ?? ''].some(value => includesCredential(value, connection.token))) {
    throw new GitlabReadError('deployments', 'invalid-response');
  }
  const jobUrl = canonicalJobUrl(row.deployable, projectUrl, repositoryId, connection);
  return { repositoryId, deploymentId: id, environment, sha, status: status as GitlabDeploymentState, changedAt,
    projectUrl, source: 'sync', ...(environmentTier === undefined ? {} : { environmentTier }), ...(jobUrl ? { jobUrl } : {}) };
}

function hasNextPage(pagination: Headers, page: number, size: number, count: number, stage: 'deployments' | 'deployment-merge-requests') {
  const next = pagination.get('x-next-page');
  const link = /;\s*rel\s*=\s*(?:"next"|next)(?=\s*[,;]|\s*$)/iu.test(pagination.get('link') ?? '');
  if ((next !== null && next !== '' && next !== String(page + 1)) || (next === '' && link) || (count === 0 && Boolean(next || link))) {
    throw new GitlabReadError(stage, 'invalid-response');
  }
  return next !== null ? next !== '' : link || count === size;
}

function uniqueMergeRequests(pairs: GitlabDeploymentMergeRequest[]) {
  const iidsById = new Map<number, Set<number>>();
  const idsByIid = new Map<number, Set<number>>();
  for (const { id, iid } of pairs) {
    const iids = iidsById.get(id) ?? new Set<number>();
    iids.add(iid);
    iidsById.set(id, iids);
    const ids = idsByIid.get(iid) ?? new Set<number>();
    ids.add(id);
    idsByIid.set(iid, ids);
  }
  const mergeRequests: GitlabDeploymentMergeRequest[] = [];
  let ambiguous = false;
  for (const [id, iids] of iidsById) {
    const iid = iids.values().next().value!;
    if (iids.size !== 1 || idsByIid.get(iid)!.size !== 1) ambiguous = true;
    else mergeRequests.push({ id, iid });
  }
  return { mergeRequests, ambiguous };
}

async function associatedMergeRequests(reader: Reader, deployment: Deployment, signal: AbortSignal, parentSignal?: AbortSignal): Promise<AssociationResult> {
  const { deploymentId, repositoryId } = deployment;
  const pairs: GitlabDeploymentMergeRequest[] = [];
  let unavailable = false;
  let more = false;
  let rateLimited = false;
  for (let page = 1; page <= MERGE_REQUEST_PAGE_LIMIT; page++) {
    try {
      signal.throwIfAborted();
      const { rows, pagination } = await reader.mergeRequests(deploymentId, MERGE_REQUEST_PAGE_SIZE, page);
      for (const { id, iid, target_project_id: targetProjectId, state } of rows) {
        if (!positiveId(id) || !positiveId(iid) || targetProjectId !== repositoryId || state !== 'merged') unavailable = true;
        else pairs.push({ id, iid });
      }
      more = hasNextPage(pagination, page, MERGE_REQUEST_PAGE_SIZE, rows.length, 'deployment-merge-requests');
      if (!more) break;
    } catch (error) {
      parentSignal?.throwIfAborted();
      unavailable = true;
      more = false;
      rateLimited = error instanceof GitlabReadError && error.httpStatus === 429;
      break;
    }
  }
  const { mergeRequests, ambiguous } = uniqueMergeRequests(pairs);
  return { mergeRequests, unavailable: unavailable || ambiguous, limited: more, rateLimited };
}

export async function readGitlabDeploymentHistory(connection: Connection, repositoryId: number, parentSignal?: AbortSignal): Promise<GitlabDeploymentHistory> {
  parentSignal?.throwIfAborted();
  const budget = AbortSignal.timeout(READ_BUDGET_MS);
  const signal = parentSignal ? AbortSignal.any([parentSignal, budget]) : budget;
  const reader = createGitlabDeploymentReader(connection, repositoryId, signal);
  const repository = await reader.repository();
  if (repository.href.length > 4_000 || includesCredential(repository.href, connection.token)) throw new GitlabReadError('project', 'invalid-response');
  const { rows, pagination } = await reader.deployments(DEPLOYMENT_LIMIT);
  parentSignal?.throwIfAborted();
  const deploymentLimitReached = hasNextPage(pagination, 1, DEPLOYMENT_LIMIT, rows.length, 'deployments');
  const deployments = rows.map(row => parseDeployment(row, repositoryId, repository.href, connection));
  if (new Set(deployments.map(deployment => deployment.deploymentId)).size !== deployments.length) {
    throw new GitlabReadError('deployments', 'invalid-response');
  }

  const successful = deployments.filter(deployment => deployment.status === 'success');
  let next = 0, associationUnavailable = 0, associationLimited = 0, rateLimited = false;
  async function readAssociations() {
    while (next < successful.length) {
      parentSignal?.throwIfAborted();
      const deployment = successful[next++];
      if (rateLimited || signal.aborted) {
        associationUnavailable++;
        continue;
      }
      const result = await associatedMergeRequests(reader, deployment, signal, parentSignal);
      if (result.mergeRequests.length) deployment.mergeRequests = result.mergeRequests;
      if (result.unavailable) associationUnavailable++;
      if (result.limited) associationLimited++;
      if (result.rateLimited) rateLimited = true;
    }
  }
  await Promise.all(Array.from({ length: Math.min(MERGE_REQUEST_CONCURRENCY, successful.length) }, readAssociations));
  parentSignal?.throwIfAborted();
  return { deployments, scanned: rows.length, deploymentLimitReached, associationUnavailable, associationLimited };
}
