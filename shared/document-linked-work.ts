import { issueDeadline } from './my-work.js';
import type { Issue, ResourceLink, WorkflowStatus, WorkspaceSnapshot } from './types.js';
import { statusMeta } from './workflow-helpers.js';

export type DocumentLinkedWorkItem = {
  link: ResourceLink;
  issue: Issue;
  projectName: string | null;
  assigneeName: string | null;
  status: WorkflowStatus;
  deadline: ReturnType<typeof issueDeadline>;
  closed: boolean;
};

type DocumentLinkedWorkData = Pick<WorkspaceSnapshot, 'issues' | 'projects' | 'users' | 'workflows' | 'resourceLinks'>;
const issueKeys = new Intl.Collator('ko', { numeric: true });

function compareRows(left: DocumentLinkedWorkItem, right: DocumentLinkedWorkItem): number {
  if (left.closed !== right.closed) return left.closed ? 1 : -1;
  if (left.deadline && right.deadline) {
    const byDeadline = left.deadline.value.localeCompare(right.deadline.value);
    if (byDeadline) return byDeadline;
  } else if (left.deadline || right.deadline) {
    return left.deadline ? -1 : 1;
  }
  return issueKeys.compare(left.issue.key, right.issue.key) || left.issue.id.localeCompare(right.issue.id);
}

export function buildDocumentLinkedWork(data: DocumentLinkedWorkData, documentId: string): {
  rows: DocumentLinkedWorkItem[];
  counts: { open: number; closed: number; evidence: number };
} {
  const issues = new Map(data.issues.map(issue => [issue.id, issue]));
  const projectNames = new Map(data.projects.map(project => [project.id, project.name]));
  const assigneeNames = new Map(data.users.map(user => [user.id, user.name]));
  const rows: DocumentLinkedWorkItem[] = [];
  const counts = { open: 0, closed: 0, evidence: 0 };

  for (const link of data.resourceLinks) {
    if (link.documentId !== documentId) continue;
    const issue = issues.get(link.issueId);
    if (!issue) continue;

    const status = statusMeta(data, issue.projectId, issue.status);
    const closed = status.category === 'done' || status.category === 'cancelled';
    counts[closed ? 'closed' : 'open']++;
    if (link.documentSource) counts.evidence++;
    rows.push({
      link, issue, status, closed, deadline: issueDeadline(issue),
      projectName: projectNames.get(issue.projectId) ?? null,
      assigneeName: issue.assigneeId ? assigneeNames.get(issue.assigneeId) ?? null : null,
    });
  }

  return { rows: rows.sort(compareRows), counts };
}
