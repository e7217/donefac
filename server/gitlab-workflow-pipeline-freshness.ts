import { gitlabObjectSha, isGitlabBranchName } from '../shared/gitlab-links.js';
import { gitlabPipelineSource } from '../shared/gitlab-pipeline-source.js';
import type { GitlabPipelineReviewReplacement } from '../shared/types.js';
import { GitlabReadError, type GitlabReadObject, type gitlabLinkedActivityReader } from './gitlab-read-sync.js';

type ReplacementPipeline = Omit<GitlabPipelineReviewReplacement, 'linkId'>;
export type GitlabWorkflowPipelineFreshness = { kind: 'latest' | 'unverified' } | { kind: 'superseded'; replacement?: ReplacementPipeline };

type PipelineReader = Pick<ReturnType<typeof gitlabLinkedActivityReader>, 'workflow' | 'workflowPipelines'>;
type PipelineIdentity = { id: number; ref: string; sha: string; source: string; tag?: boolean };

const pageSize = 20;
const maximumPages = 2;
const maximumDetails = 10;
const freshnessDeadlineMs = 8_000;

function pipelineIdentity(object: GitlabReadObject, repositoryId: number): PipelineIdentity | null {
  const { id, ref, tag } = object;
  const sha = gitlabObjectSha(object.sha);
  const source = gitlabPipelineSource(object.source);
  if (object.project_id !== repositoryId || typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 ||
      !isGitlabBranchName(ref) || !sha || /^0+$/u.test(sha) || !source || (tag !== undefined && typeof tag !== 'boolean')) return null;
  return { id, ref, sha, source, tag };
}

function matchesRevision(row: GitlabReadObject, selected: GitlabReadObject) {
  if (typeof selected.status !== 'string' || row.status !== selected.status) return false;
  if (row.updated_at === undefined) return true;
  return typeof row.updated_at === 'string' && typeof selected.updated_at === 'string' &&
    Date.parse(row.updated_at) === Date.parse(selected.updated_at);
}

function replacementPipeline(repositoryId: number, verified: PipelineIdentity, detail: GitlabReadObject, webUrl: string): ReplacementPipeline | undefined {
  const { id, ref, source, tag, sha } = verified;
  const { status } = detail;
  if (tag === undefined || typeof status !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/u.test(status) || status === 'unknown') return;
  return { repositoryId, pipelineId: id, ref, source, tag, sha, status, webUrl };
}

export async function readGitlabWorkflowPipelineFreshness(reader: PipelineReader, repositoryId: number, selectedObject: GitlabReadObject,
  signal?: AbortSignal): Promise<GitlabWorkflowPipelineFreshness> {
  const selected = pipelineIdentity(selectedObject, repositoryId);
  if (!selected || selected.tag === undefined) return { kind: 'unverified' };
  const deadline = AbortSignal.timeout(freshnessDeadlineMs);
  const readSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let previousId = Infinity, checkedDetails = 0;
  let superseding: Extract<GitlabWorkflowPipelineFreshness, { kind: 'superseded' }> | undefined;
  try {
    // GitLab's branches/tags scopes truncate each ref before filtering by source. Use the ordered source/ref list and verify tags on exact detail.
    for (let page = 1; page <= maximumPages; page++) {
      const { rows, hasNextPage } = await reader.workflowPipelines(repositoryId, { ref: selected.ref, source: selected.source, page, perPage: pageSize }, readSignal);
      const identities: PipelineIdentity[] = [];
      for (const row of rows) {
        const candidate = pipelineIdentity(row, repositoryId);
        if (!candidate || candidate.ref !== selected.ref || candidate.id >= previousId) return { kind: 'unverified' };
        previousId = candidate.id;
        identities.push(candidate);
      }
      for (const [index, candidate] of identities.entries()) {
        if (candidate.id < selected.id) return { kind: 'unverified' };
        if (candidate.id === selected.id) {
          if (candidate.sha !== selected.sha || candidate.source !== selected.source ||
              (candidate.tag !== undefined && candidate.tag !== selected.tag) || !matchesRevision(rows[index], selectedObject)) return { kind: 'unverified' };
          return superseding ?? { kind: 'latest' };
        }
        if (superseding || candidate.source !== selected.source) continue;
        if (checkedDetails === maximumDetails) return { kind: 'unverified' };
        checkedDetails++;
        const { object, webUrl } = await reader.workflow(repositoryId, 'pipeline', candidate.id, candidate.id, readSignal);
        const verified = pipelineIdentity(object, repositoryId);
        if (!verified || verified.id !== candidate.id || verified.ref !== candidate.ref || verified.source !== candidate.source ||
            verified.sha !== candidate.sha || verified.tag === undefined || (candidate.tag !== undefined && candidate.tag !== verified.tag)) return { kind: 'unverified' };
        if (verified.tag === selected.tag) {
          const replacement = replacementPipeline(repositoryId, verified, object, webUrl);
          superseding = { kind: 'superseded', ...(replacement ? { replacement } : {}) };
        }
      }
      if (!hasNextPage) break;
    }
  } catch (error) {
    if (!(error instanceof GitlabReadError) && !readSignal.aborted) throw error;
  }
  return { kind: 'unverified' };
}
