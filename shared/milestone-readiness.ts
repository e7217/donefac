import type { Issue, Milestone, WorkflowStatus, WorkspaceSnapshot } from './types.js';
import { projectWorkflow, statusMeta } from './workflow-helpers.js';

export const MILESTONE_READINESS_KINDS = ['late', 'unscheduled', 'within', 'done', 'cancelled', 'unavailable'] as const;
export type MilestoneReadinessKind = typeof MILESTONE_READINESS_KINDS[number];
export const MILESTONE_READINESS_LABELS: Record<MilestoneReadinessKind, string> = {
  late: '이정표 이후',
  unscheduled: '종료일 미정',
  within: '이정표 이내',
  done: '완료',
  cancelled: '취소',
  unavailable: '확인 불가',
};

type MilestoneReadinessRow = {
  issue: Issue;
  kind: Exclude<MilestoneReadinessKind, 'unavailable'>;
  status: WorkflowStatus;
};
export type MilestoneReadiness = {
  counts: Record<MilestoneReadinessKind, number>;
  rows: MilestoneReadinessRow[];
};

const issueKeys = new Intl.Collator('ko', { numeric: true });

function readinessKind(issue: Issue, milestone: Milestone, status: WorkflowStatus): MilestoneReadinessRow['kind'] {
  if (status.category === 'done' || status.category === 'cancelled') return status.category;
  if (!issue.endDate) return 'unscheduled';
  return issue.endDate > milestone.date ? 'late' : 'within';
}

function compareReadiness(left: MilestoneReadinessRow, right: MilestoneReadinessRow): number {
  const rank = MILESTONE_READINESS_KINDS.indexOf(left.kind) - MILESTONE_READINESS_KINDS.indexOf(right.kind);
  if (rank) return rank;
  const leftEnd = left.issue.endDate ?? '';
  const rightEnd = right.issue.endDate ?? '';
  if (left.kind === 'late' && leftEnd !== rightEnd) return rightEnd.localeCompare(leftEnd);
  if (left.kind === 'within' && leftEnd !== rightEnd) return leftEnd.localeCompare(rightEnd);
  return issueKeys.compare(left.issue.key, right.issue.key) || left.issue.id.localeCompare(right.issue.id);
}

export function milestoneReadiness(milestone: Milestone, issuesById: ReadonlyMap<string, Issue>,
  data: Pick<WorkspaceSnapshot, 'workflows'>): MilestoneReadiness {
  const counts: MilestoneReadiness['counts'] = { late: 0, unscheduled: 0, within: 0, done: 0, cancelled: 0, unavailable: 0 };
  const rows: MilestoneReadinessRow[] = [];
  const workflowData = { workflows: [projectWorkflow(data, milestone.projectId)] };
  for (const id of new Set(milestone.issueIds)) {
    const issue = issuesById.get(id);
    if (!issue || issue.projectId !== milestone.projectId) {
      counts.unavailable++;
      continue;
    }
    const status = statusMeta(workflowData, milestone.projectId, issue.status);
    const kind = readinessKind(issue, milestone, status);
    counts[kind]++;
    rows.push({ issue, kind, status });
  }
  return { counts, rows: rows.sort(compareReadiness) };
}
