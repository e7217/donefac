import { isGitlabBranchName } from './gitlab-links.js';
import type { GitlabLink } from './types.js';

export interface IssueGitlabSummary {
  activityCount: number;
  openMergeRequests: number;
  failedPipelines: number;
  runningPipelines: number;
}

const activePipelineStates = new Set(['created', 'waiting_for_resource', 'preparing', 'pending', 'running']);
const pipelineLinkIdPrefix = /^gitlab:([a-f0-9]{12}):([1-9]\d*):pipeline:([1-9]\d*):/u;

function pipelineBranch(link: GitlabLink) {
  if (!isGitlabBranchName(link.sourceBranch)) return null;
  const match = pipelineLinkIdPrefix.exec(link.id);
  if (!match || match[2] !== String(link.projectId) || link.id.slice(match[0].length) !== link.issueId) return null;
  // GitLab's object ID determines pipeline creation order. The stored IID and update timestamp can differ.
  const id = Number(match[3]);
  if (!Number.isSafeInteger(id)) return null;
  return { id, key: JSON.stringify([match[1], link.projectId, link.sourceBranch, link.issueId]) };
}

function countPipeline(summary: IssueGitlabSummary, state: string) {
  if (state === 'failed') summary.failedPipelines++;
  else if (activePipelineStates.has(state)) summary.runningPipelines++;
}

export function summarizeIssueGitlabLinks(links: readonly GitlabLink[]): ReadonlyMap<string, IssueGitlabSummary> {
  const summaries = new Map<string, IssueGitlabSummary>();
  const latestPipelines = new Map<string, { id: number; state: string; summary: IssueGitlabSummary }>();
  for (const link of links) {
    let summary = summaries.get(link.issueId);
    if (!summary) {
      summary = { activityCount: 0, openMergeRequests: 0, failedPipelines: 0, runningPipelines: 0 };
      summaries.set(link.issueId, summary);
    }
    summary.activityCount++;
    if (link.kind === 'merge_request' && link.state === 'opened') summary.openMergeRequests++;
    if (link.kind !== 'pipeline') continue;

    const branch = pipelineBranch(link);
    if (!branch) {
      countPipeline(summary, link.state);
      continue;
    }
    const latest = latestPipelines.get(branch.key);
    if (!latest || latest.id < branch.id) {
      latestPipelines.set(branch.key, { id: branch.id, state: link.state, summary });
    }
  }
  for (const { state, summary } of latestPipelines.values()) countPipeline(summary, state);
  return summaries;
}
