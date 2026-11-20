'use client';

import type { Issue } from '../../shared/types';
import './issue-hierarchy-context.css';

export function buildIssueHierarchy(issues: readonly Issue[]) {
  const byId = new Map(issues.map(issue => [issue.id, issue]));
  const parents = new Map<string, Issue>();
  const childCounts = new Map<string, number>();
  for (const issue of issues) {
    const parent = issue.parentId ? byId.get(issue.parentId) : undefined;
    if (!parent || parent.projectId !== issue.projectId || parent.id === issue.id) continue;
    parents.set(issue.id, parent);
    childCounts.set(parent.id, (childCounts.get(parent.id) ?? 0) + 1);
  }
  return { parents, childCounts };
}

export function IssueHierarchyContext({ issueId, hierarchy, openIssue, disabled = false }: {
  issueId: string;
  hierarchy: ReturnType<typeof buildIssueHierarchy>;
  openIssue: (id: string) => void;
  disabled?: boolean;
}) {
  const parent = hierarchy.parents.get(issueId);
  const childCount = hierarchy.childCounts.get(issueId) ?? 0;
  if (!parent && childCount === 0) return null;

  return <div className="issue-hierarchy-context">
    {parent && <button type="button" className="issue-hierarchy-parent" disabled={disabled}
      aria-label={`상위 업무 열기 ${parent.key} ${parent.title}`} title={`${parent.key} · ${parent.title}`}
      onClick={() => openIssue(parent.id)}>상위 {parent.key}</button>}
    {childCount > 0 && <span className="issue-child-mark issue-hierarchy-children">하위 업무 {childCount}개</span>}
  </div>;
}
