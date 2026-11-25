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
  manualPipelines: number;
}

const activePipelineStates = new Set(['created', 'waiting_for_resource', 'preparing', 'pending', 'running']);

export function isGitlabPipelineRunning(state: string): boolean {
  return activePipelineStates.has(state);
}

export function gitlabPipelineGroup(link: GitlabLink) {
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
  else if (isGitlabPipelineRunning(state)) summary.runningPipelines++;
  else if (state === 'manual') summary.manualPipelines++;
}

export function latestGitlabPipelineLinks(links: readonly GitlabLink[]): GitlabLink[] {
  const ungrouped: GitlabLink[] = [];
  const grouped = new Map<string, { id: number; link: GitlabLink }>();
  for (const link of links) {
    if (link.kind !== 'pipeline') continue;
    const group = gitlabPipelineGroup(link);
    if (!group) {
      ungrouped.push(link);
      continue;
    }
    const latest = grouped.get(group.key);
    if (!latest || latest.id < group.id) grouped.set(group.key, { id: group.id, link });
  }
  return [...ungrouped, ...Array.from(grouped.values(), ({ link }) => link)];
}

export function summarizeIssueGitlabLinks(links: readonly GitlabLink[]): ReadonlyMap<string, IssueGitlabSummary> {
  const summaries = new Map<string, IssueGitlabSummary>();
  for (const link of links) {
    let summary = summaries.get(link.issueId);
    if (!summary) {
      summary = { activityCount: 0, openMergeRequests: 0, blockedMergeRequests: 0, failedPipelines: 0, runningPipelines: 0, manualPipelines: 0 };
      summaries.set(link.issueId, summary);
    }
    summary.activityCount++;
    if (link.kind === 'merge_request' && link.state === 'opened') {
      summary.openMergeRequests++;
      if (isGitlabMergeReadinessBlocked(link.mergeReadiness?.state)) summary.blockedMergeRequests++;
    }
  }
  for (const link of latestGitlabPipelineLinks(links)) {
    const summary = summaries.get(link.issueId);
    if (summary) countPipeline(summary, link.state);
  }
  return summaries;
}
