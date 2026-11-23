import type { LegacyRecord } from '../shared/types.js';

const issueId = /^[1-9]\d{0,24}$/u;
const issueKey = /^[A-Z][A-Z0-9_]*-[1-9]\d*$/u;

export const isJiraHierarchyIssueId = (value: string) => issueId.test(value);
export const isJiraHierarchyIssueKey = (value: string) => value.length <= 200 && issueKey.test(value);

export function jiraParentEvidence(row: LegacyRecord): string[] | null | undefined {
  if (row.kind !== 'issue') return;
  const { jiraParentSourceId: id, jiraParentSourceKey: key } = row.metadata;
  if (id !== row.parentId) return;
  const references = row.references.filter(reference => reference.kind === 'issue' && reference.relation === 'parent');
  if (id === null) return !references.length && key === undefined ? null : undefined;
  if (typeof id !== 'string' || !isJiraHierarchyIssueId(id) && !isJiraHierarchyIssueKey(id)) return;
  if (!references.length || references.some(reference => reference.sourceId !== id && reference.sourceId !== key)) return;
  if (key === undefined) return [id];
  return typeof key === 'string' && isJiraHierarchyIssueKey(key) && key !== id ? [id, key] : undefined;
}
