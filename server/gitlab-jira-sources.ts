import { isJiraIssueKey } from '../shared/atlassian-links.js';
import type { GitlabJiraRoute, GitlabJiraSource } from '../shared/types.js';
import type { Store } from './store.js';

interface SourceRow extends GitlabJiraSource {
  jiraKey: string;
  issueId: string;
}

type OriginalIssue = { issueId: string; originalJiraKey: string };

// The binding table also indexes source IDs. Only an exact archived Jira key establishes a GitLab alias.
const archiveJson = "CASE WHEN json_valid(archive.json) THEN archive.json ELSE '{}' END";
const sourceRows = `
  SELECT binding.source_instance AS jiraInstanceKey, projects.id AS projectId,
    binding.source_alias AS jiraKey, binding.target_id AS issueId
  FROM source_bindings AS binding
  JOIN source_records AS archive ON archive.target_type='issue' AND archive.target_id=binding.target_id
    AND archive.product=binding.product AND archive.source_instance=binding.source_instance AND archive.kind=binding.kind
    AND json_extract(${archiveJson},'$.record.metadata.key')=binding.source_alias
  JOIN projects ON projects.id=json_extract(${archiveJson},'$.targetProjectId')
  WHERE binding.product='jira' AND binding.kind='issue' AND binding.target_type='issue'`;

export function gitlabJiraSources(store: Store): GitlabJiraSource[] {
  const pairs = new Map<string, GitlabJiraSource>();
  const rows = store.db.prepare(sourceRows).iterate() as Iterable<SourceRow>;
  for (const { projectId, jiraInstanceKey, jiraKey } of rows) {
    if (isJiraIssueKey(jiraKey)) pairs.set(JSON.stringify([projectId, jiraInstanceKey]), { projectId, jiraInstanceKey });
  }
  return [...pairs.values()].sort((left, right) => left.projectId.localeCompare(right.projectId)
    || left.jiraInstanceKey.localeCompare(right.jiraInstanceKey));
}

export function gitlabJiraOriginalKeys(store: Store, { projectId, jiraInstanceKey }: GitlabJiraRoute): Map<string, OriginalIssue | null> {
  const byKey = new Map<string, OriginalIssue | null>();
  const rows = store.db.prepare(`${sourceRows} AND binding.source_instance=? AND projects.id=?`).iterate(jiraInstanceKey, projectId) as Iterable<SourceRow>;
  for (const { jiraKey, issueId } of rows) {
    if (!isJiraIssueKey(jiraKey)) continue;
    const normalized = jiraKey.toUpperCase();
    const previous = byKey.get(normalized);
    if (previous === null) continue;
    if (previous && previous.issueId !== issueId) byKey.set(normalized, null);
    else if (!previous || jiraKey < previous.originalJiraKey) byKey.set(normalized, { issueId, originalJiraKey: jiraKey });
  }
  return byKey;
}
