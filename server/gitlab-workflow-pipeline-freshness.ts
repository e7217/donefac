import { gitlabObjectSha, isGitlabBranchName } from '../shared/gitlab-links.js';
import { gitlabPipelineSource } from '../shared/gitlab-pipeline-source.js';
import { GitlabReadError, type GitlabReadObject, type gitlabLinkedActivityReader } from './gitlab-read-sync.js';

export type GitlabWorkflowPipelineFreshness = 'latest' | 'superseded' | 'unverified';

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

export async function readGitlabWorkflowPipelineFreshness(reader: PipelineReader, repositoryId: number, selectedObject: GitlabReadObject,
  signal?: AbortSignal): Promise<GitlabWorkflowPipelineFreshness> {
  const selected = pipelineIdentity(selectedObject, repositoryId);
  if (!selected || selected.tag === undefined) return 'unverified';
  const deadline = AbortSignal.timeout(freshnessDeadlineMs);
  const readSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let previousId = Infinity, checkedDetails = 0, superseded = false;
  try {
    // GitLab's branches/tags scopes truncate each ref before filtering by source. Use the ordered source/ref list and verify tags on exact detail.
    for (let page = 1; page <= maximumPages; page++) {
      const { rows, hasNextPage } = await reader.workflowPipelines(repositoryId, { ref: selected.ref, source: selected.source, page, perPage: pageSize }, readSignal);
      const identities: PipelineIdentity[] = [];
      for (const row of rows) {
        const candidate = pipelineIdentity(row, repositoryId);
        if (!candidate || candidate.ref !== selected.ref || candidate.id >= previousId) return 'unverified';
        previousId = candidate.id;
        identities.push(candidate);
      }
      for (const [index, candidate] of identities.entries()) {
        if (candidate.id < selected.id) return 'unverified';
        if (candidate.id === selected.id) {
          if (candidate.sha !== selected.sha || candidate.source !== selected.source ||
              (candidate.tag !== undefined && candidate.tag !== selected.tag) || !matchesRevision(rows[index], selectedObject)) return 'unverified';
          return superseded ? 'superseded' : 'latest';
        }
        if (superseded || candidate.source !== selected.source) continue;
        if (checkedDetails === maximumDetails) return 'unverified';
        checkedDetails++;
        const { object } = await reader.workflow(repositoryId, 'pipeline', candidate.id, candidate.id, readSignal);
        const verified = pipelineIdentity(object, repositoryId);
        if (!verified || verified.id !== candidate.id || verified.ref !== candidate.ref || verified.source !== candidate.source ||
            verified.sha !== candidate.sha || verified.tag === undefined || (candidate.tag !== undefined && candidate.tag !== verified.tag)) return 'unverified';
        superseded = verified.tag === selected.tag;
      }
      if (!hasNextPage) break;
    }
  } catch (error) {
    if (!(error instanceof GitlabReadError) && !readSignal.aborted) throw error;
  }
  return 'unverified';
}
