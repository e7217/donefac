import { gitlabPipelineLinkIdentity, isGitlabBranchName } from './gitlab-links.js';
import { isGitlabMergeReadinessBlocked } from './gitlab-merge-readiness.js';
import { gitlabPipelineSource } from './gitlab-pipeline-source.js';
import type { GitlabLink } from './types.js';

export interface IssueGitlabSummary {
  activityCount: number;
  openMergeRequests: number;
  blockedMergeRequests: number;
  failedPipelines: number;
  runningPipelines: number;
}

const activePipelineStates = new Set(['created', 'waiting_for_resource', 'preparing', 'pending', 'running']);

function pipelineGroup(link: GitlabLink) {
  if (!isGitlabBranchName(link.sourceBranch)) return null;
  const identity = gitlabPipelineLinkIdentity(link);
  if (!identity) return null;
  const source = gitlabPipelineSource(link.pipelineSource) ?? null;
  // GitLab's object ID determines pipeline creation order. The stored IID and update timestamp can differ.
  return { id: identity.objectId, key: JSON.stringify([
    identity.instance, link.projectId, link.sourceBranch, link.issueId, source, link.pipelineTag === true,
  ]) };
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
      summary = { activityCount: 0, openMergeRequests: 0, blockedMergeRequests: 0, failedPipelines: 0, runningPipelines: 0 };
      summaries.set(link.issueId, summary);
    }
    summary.activityCount++;
    if (link.kind === 'merge_request' && link.state === 'opened') {
      summary.openMergeRequests++;
      if (isGitlabMergeReadinessBlocked(link.mergeReadiness?.state)) summary.blockedMergeRequests++;
    }
    if (link.kind !== 'pipeline') continue;

    const group = pipelineGroup(link);
    if (!group) {
      countPipeline(summary, link.state);
      continue;
    }
    const latest = latestPipelines.get(group.key);
    if (!latest || latest.id < group.id) {
      latestPipelines.set(group.key, { id: group.id, state: link.state, summary });
    }
  }
  for (const { state, summary } of latestPipelines.values()) countPipeline(summary, state);
  return summaries;
}
