import { CircleAlert, GitMerge, GitPullRequest, Timer } from 'lucide-react';
import type { IssueGitlabSummary as GitlabSummary } from '../../shared/issue-gitlab-view';
import type { IssueViewGitlabFilter } from '../../shared/types';
import './issue-gitlab-summary.css';

export const ISSUE_GITLAB_FILTER_LABELS = {
  open_merge_request: '열린 MR',
  failed_pipeline: '실패한 파이프라인',
  running_pipeline: '진행 중인 파이프라인',
  no_activity: '연결된 GitLab 활동 없음',
} satisfies Record<IssueViewGitlabFilter, string>;

export function IssueGitlabSummary({ summary }: { summary?: GitlabSummary }) {
  if (!summary?.activityCount) return null;
  const { activityCount, openMergeRequests, failedPipelines, runningPipelines } = summary;
  return <span className="issue-gitlab-summary">
    {failedPipelines > 0 && <span className="issue-gitlab-state is-failed">
      <CircleAlert size={12} aria-hidden="true" />실패한 파이프라인 {failedPipelines}개
    </span>}
    {runningPipelines > 0 && <span className="issue-gitlab-state">
      <Timer size={12} aria-hidden="true" />진행 중인 파이프라인 {runningPipelines}개
    </span>}
    {openMergeRequests > 0 && <span className="issue-gitlab-state">
      <GitPullRequest size={12} aria-hidden="true" />열린 MR {openMergeRequests}개
    </span>}
    {!failedPipelines && !runningPipelines && !openMergeRequests && <span className="issue-gitlab-state">
      <GitMerge size={12} aria-hidden="true" />GitLab 활동 {activityCount}개
    </span>}
  </span>;
}
