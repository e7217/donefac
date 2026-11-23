import { isJiraIssueKey } from './atlassian-links.js';
import { isGitlabMergeReadiness } from './gitlab-merge-readiness.js';
import { gitlabPipelineSource } from './gitlab-pipeline-source.js';
import type { GitlabLink } from './types.js';

export function gitlabObjectSha(value: unknown): string | null {
  return typeof value === 'string' && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value) ? value.toLowerCase() : null;
}

export function isGitlabBranchName(value: unknown): value is string {
  if (typeof value !== 'string' || !value.length || value.length > 512 || !value.isWellFormed() || value === '@') return false;
  if (value.startsWith('-') || value.endsWith('.') || value.includes('..') || value.includes('@{') || value.includes('[') || value.includes('\\') || /[\u0000-\u0020\u007f~^:?*]/u.test(value)) return false;
  return value.split('/').every(segment => segment.length > 0 && !segment.startsWith('.') && !segment.endsWith('.lock'));
}

export function isGitlabManualLinkId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
}

const pipelineObjectPrefix = /^gitlab:([a-f0-9]{12}):([1-9]\d*):pipeline:([1-9]\d*):/u;

export function gitlabPipelineLinkIdentity({ id, projectId, issueId }: Pick<GitlabLink, 'id' | 'issueId' | 'projectId'>) {
  if (typeof id !== 'string' || typeof issueId !== 'string' || !issueId || !Number.isSafeInteger(projectId)) return null;
  const match = pipelineObjectPrefix.exec(id);
  if (!match || match[2] !== String(projectId) || id.slice(match[0].length) !== issueId) return null;
  const objectId = Number(match[3]);
  return Number.isSafeInteger(objectId) ? { instance: match[1], objectId } : null;
}

function isCanonicalLinkUrl(webUrl: unknown, suffix: string): boolean {
  if (typeof webUrl !== 'string' || webUrl.length > 4_000) return false;
  let url: URL;
  try { url = new URL(webUrl); }
  catch { return false; }
  return /^https?:$/u.test(url.protocol) && !url.username && !url.password && !url.search && !url.hash &&
    url.href === webUrl && url.pathname.length > suffix.length && url.pathname.endsWith(suffix);
}

function isRestorableBranchLink(link: Record<string, unknown>): boolean {
  const { iid, projectId, title, sourceBranch, sourceSha, state, updatedAt, webUrl } = link;
  const sha = gitlabObjectSha(sourceSha);
  return iid === 0 && typeof projectId === 'number' && Number.isSafeInteger(projectId) && projectId > 0 &&
    isGitlabBranchName(sourceBranch) && title === sourceBranch && Boolean(sha) && !/^0+$/.test(sha ?? '') &&
    (state === 'active' || state === 'deleted') && typeof updatedAt === 'string' && Number.isFinite(Date.parse(updatedAt)) &&
    isCanonicalLinkUrl(webUrl, `/-/tree/${encodeURIComponent(sourceBranch)}`);
}

function isRestorableManualGitlabLink(link: Record<string, unknown>): boolean {
  const { id, issueId, projectId, kind, iid, title, state, updatedAt, webUrl, manualLinkId, sourceSha } = link;
  if (!isGitlabManualLinkId(manualLinkId) || typeof kind !== 'string' ||
      Object.hasOwn(link, 'originalJiraKey') || typeof issueId !== 'string' || !issueId || typeof id !== 'string' ||
      typeof projectId !== 'number' || !Number.isSafeInteger(projectId) || projectId < 1) return false;
  const [, instance, , , objectId] = id.split(':', 5);
  if (!/^[a-f0-9]{12}$/u.test(instance) ||
      id !== `gitlab:${instance}:${projectId}:${kind}:${objectId}:${issueId}`) return false;

  if (kind === 'branch') return /^[a-f0-9]{64}$/u.test(objectId) && isRestorableBranchLink(link);
  if (typeof title !== 'string' || !title || title.length > 500 || typeof state !== 'string' || !state || state.length > 100 ||
      typeof updatedAt !== 'string' || !Number.isFinite(Date.parse(updatedAt))) return false;
  if (kind === 'commit') {
    return iid === 0 && state === 'committed' && gitlabObjectSha(objectId) === objectId && !/^0+$/.test(objectId) &&
      sourceSha === objectId && isCanonicalLinkUrl(webUrl, `/-/commit/${objectId}`);
  }
  if ((kind !== 'merge_request' && kind !== 'pipeline') || typeof iid !== 'number' || !Number.isSafeInteger(iid) || iid < 1 ||
      !/^[1-9]\d*$/u.test(objectId) || !Number.isSafeInteger(Number(objectId))) return false;
  const suffix = kind === 'merge_request' ? `/-/merge_requests/${iid}` : `/-/pipelines/${objectId}`;
  return isCanonicalLinkUrl(webUrl, suffix);
}

export function isRestorableGitlabLink(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const link = value as Record<string, unknown>;
  const { kind, id, issueId, projectId } = link;
  const hasSource = Object.hasOwn(link, 'pipelineSource');
  const hasTag = Object.hasOwn(link, 'pipelineTag');
  if ((hasSource || hasTag) &&
      (kind !== 'pipeline' || typeof id !== 'string' || typeof issueId !== 'string' || typeof projectId !== 'number' ||
       !gitlabPipelineLinkIdentity({ id, issueId, projectId }) ||
       (hasSource && !gitlabPipelineSource(link.pipelineSource)) ||
       (hasTag && typeof link.pipelineTag !== 'boolean'))) return false;
  if (Object.hasOwn(link, 'pipelineObservedAt')) {
    const { pipelineObservedAt, updatedAt, kind, state } = link;
    if (kind !== 'pipeline') return false;
    if (pipelineObservedAt !== null) {
      if (typeof pipelineObservedAt !== 'string' || pipelineObservedAt !== updatedAt ||
          typeof state !== 'string' || !state || state === 'unknown' || state.length > 100) return false;
      const time = Date.parse(pipelineObservedAt);
      if (!Number.isFinite(time) || time > Date.now() || new Date(time).toISOString() !== pipelineObservedAt) return false;
    }
  }
  if (Object.hasOwn(link, 'mergeReadiness') &&
      (link.kind !== 'merge_request' || link.state !== 'opened' || !isGitlabMergeReadiness(link.mergeReadiness))) return false;
  if (Object.hasOwn(link, 'mergeCommitShas')) {
    const { id, projectId, issueId, iid, mergeCommitShas } = link;
    const objectKey = typeof id === 'string' && /^gitlab:([a-f\d]{12}):([1-9]\d*):merge_request:([1-9]\d*):/u.exec(id);
    if (link.kind !== 'merge_request' || link.state !== 'merged' || !objectKey || String(projectId) !== objectKey[2] ||
        typeof projectId !== 'number' || !Number.isSafeInteger(projectId) || !Number.isSafeInteger(Number(objectKey[3])) ||
        typeof issueId !== 'string' || !issueId || id !== `${objectKey[0]}${issueId}` ||
        typeof iid !== 'number' || !Number.isSafeInteger(iid) || iid < 1 ||
        !Array.isArray(mergeCommitShas) || mergeCommitShas.length < 1 || mergeCommitShas.length > 2 ||
        mergeCommitShas.some((sha, index) => typeof sha !== 'string' || gitlabObjectSha(sha) !== sha || /^0+$/u.test(sha) ||
          index > 0 && mergeCommitShas[index - 1] >= sha)) return false;
  }
  if (Object.hasOwn(link, 'originalJiraKey') && !isJiraIssueKey(link.originalJiraKey)) return false;
  if (Object.hasOwn(link, 'branchObservationSource') &&
      (link.kind !== 'branch' || link.branchObservationSource !== 'sync' || link.state !== 'active')) return false;
  if (Object.hasOwn(link, 'manualLinkId')) return isRestorableManualGitlabLink(link);
  if (link.kind !== 'branch') {
    return typeof link.kind === 'string' && ['merge_request', 'commit', 'pipeline'].includes(link.kind) && Number.isInteger(link.projectId) &&
      typeof link.webUrl === 'string' && /^https?:\/\//.test(link.webUrl);
  }

  return isRestorableBranchLink(link);
}
