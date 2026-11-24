import type { GitlabLink, Issue } from '../../shared/types';

export type IssueReviewDirection = 'previous' | 'next';
export type GitlabIssueReviewSelection = Pick<GitlabLink, 'id' | 'issueId' | 'projectId' | 'kind' | 'iid' | 'manualLinkId'>;
export type IssueReviewSource = {
  issueIds: readonly string[];
  opener: HTMLElement;
  fallback: HTMLElement | null;
  gitlabActivity?: GitlabIssueReviewSelection;
};
export type OpenIssueForReview = (id: string, source: IssueReviewSource) => void;
type IssueReviewTarget = Pick<Issue, 'id' | 'key'>;
export type IssueReviewPosition = {
  position: number;
  total: number;
  previous: IssueReviewTarget | null;
  next: IssueReviewTarget | null;
  focusDirection?: IssueReviewDirection;
};

export function issueReviewPosition(
  orderedIds: readonly string[],
  currentId: string,
  issues: readonly Pick<Issue, 'id' | 'key' | 'projectId'>[],
  projectScope: string | null,
): IssueReviewPosition | undefined {
  const active = new Map(issues.map(issue => [issue.id, issue]));
  const available: IssueReviewTarget[] = [];
  for (const id of new Set(orderedIds)) {
    const issue = active.get(id);
    if (issue && (id === currentId || projectScope === null || issue.projectId === projectScope)) {
      available.push({ id: issue.id, key: issue.key });
    }
  }
  const index = available.findIndex(issue => issue.id === currentId);
  if (index < 0) return undefined;
  return {
    position: index + 1, total: available.length,
    previous: available[index - 1] ?? null, next: available[index + 1] ?? null,
  };
}
