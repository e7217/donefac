import type { Issue, ProjectIssueSchema, SavedViewState, WorkspaceSnapshot } from './types.js';
import { createIssueFieldMatcher } from './issue-field-filter.js';
import { issueSearchText } from './issue-schema.js';

/** The same criteria drive the issue screen and snapshots of a shared view. */
export function createIssueViewMatcher(
  filters: SavedViewState['filters'],
  data: Pick<WorkspaceSnapshot, 'issueSchemas' | 'users'>,
  schema: ProjectIssueSchema,
): (issue: Issue) => boolean {
  const {status,assigneeId,type} = filters;
  const search = filters.query.toLowerCase();
  const matchFields = createIssueFieldMatcher(filters.fieldFilter, schema);
  return issue =>
    (status === 'all' || issue.status === status) &&
    (assigneeId === 'all' || (assigneeId === 'none' ? !issue.assigneeId : issue.assigneeId === assigneeId)) &&
    (type === 'all' || issue.type === type) &&
    matchFields(issue) &&
    (!search || issueSearchText(data, issue).toLowerCase().includes(search));
}
