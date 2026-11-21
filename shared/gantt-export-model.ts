import { planningMeta, PLANNING_STATUS_META } from './planning-helpers.js';
import type { DependencyScheduleCheck } from './schedule-dependencies.js';
import type {
  BaselineIssue, BaselineMilestone, Dependency, Issue, Milestone, PlanningItem, ScheduleBaseline, WorkspaceSnapshot,
} from './types.js';
import { projectStatuses } from './workflow-helpers.js';

type TimelineDates = { startDate: string | null; endDate: string | null; targetDate: string | null };

export interface GanttExportRow extends TimelineDates {
  kind: 'issue' | 'plan' | 'milestone';
  kindLabel: string | null;
  key: string | null;
  title: string;
  projectKey: string | null;
  projectName?: string;
  status: string | null;
  assignee: string | null;
  baseline: TimelineDates | null;
  historical: boolean;
}

export interface GanttExportDependency {
  predecessorKey: string;
  successorKey: string;
  type: string;
  lagDays: number;
  check: DependencyScheduleCheck | null;
}

type ReportScope = {
  title: string;
  capturedAt: string;
  range: { startDate: string; endDate: string };
  today: string;
  nonworkingDates: string[];
  filters: string[];
};
export interface GanttExportReport extends ReportScope {
  baselineName: string | null;
  rows: GanttExportRow[];
  dependencies: GanttExportDependency[];
}

type GanttExportInput = ReportScope & {
  data: Pick<WorkspaceSnapshot, 'projects' | 'users' | 'workflows' | 'issueSchemas'>;
  includeProjectLabel?: boolean;
  issues: Issue[];
  planningRows: PlanningItem[];
  milestones: Milestone[];
  baseline?: ScheduleBaseline;
  historicalIssues: BaselineIssue[];
  historicalMilestones: BaselineMilestone[];
  dependencies: Dependency[];
  findings?: ReadonlyMap<string, DependencyScheduleCheck>;
};

const dates = (startDate: string | null, endDate: string | null, targetDate: string | null): TimelineDates =>
  ({ startDate, endDate, targetDate });

/** Keep the chart's row scope and order and copy only the fields printed in the report. */
export function buildGanttExportReport(input: GanttExportInput): GanttExportReport {
  const {
    title, capturedAt, range, today, nonworkingDates, filters, data, includeProjectLabel, issues, planningRows, milestones, baseline,
    historicalIssues, historicalMilestones, dependencies, findings,
  } = input;
  const users = new Map(data.users.map(user => [user.id, user.name]));
  const projects = new Map(data.projects.map(project => [project.id, project]));
  const projectStatusNames = new Map([...new Set(issues.map(issue => issue.projectId))].map(projectId =>
    [projectId, new Map(projectStatuses(data, projectId).map(({ id, label }) => [id, label]))],
  ));
  const issueKeys = new Map(issues.map(issue => [issue.id, issue.key]));
  const issueBaseline = new Map(baseline?.issues.map(issue => [issue.issueId, issue]));
  const milestoneBaseline = new Map(baseline?.milestones.map(milestone => [milestone.milestoneId, milestone]));
  const assignee = (id: string | null) => (id && users.get(id)) || null;
  const projectLabel = (id: string | undefined): Pick<GanttExportRow, 'projectKey' | 'projectName'> => {
    const project = id ? projects.get(id) : undefined;
    return { projectKey: project?.key ?? null, ...(includeProjectLabel && project ? { projectName: project.name } : {}) };
  };

  const rows: GanttExportRow[] = [
    ...planningRows.map((plan): GanttExportRow => ({
      kind: 'plan', kindLabel: planningMeta(plan.kind).label, title: plan.name, key: null,
      ...projectLabel(plan.projectId),
      status: PLANNING_STATUS_META[plan.status].label, assignee: assignee(plan.ownerId),
      ...dates(plan.startDate, plan.endDate, plan.targetDate), baseline: null, historical: false,
    })),
    ...issues.map((issue): GanttExportRow => {
      const captured = issueBaseline.get(issue.id);
      return {
        kind: 'issue', kindLabel: null, title: issue.title, key: issue.key,
        ...projectLabel(issue.projectId),
        status: projectStatusNames.get(issue.projectId)?.get(issue.status) ?? '상태 미확인', assignee: assignee(issue.assigneeId),
        ...dates(issue.startDate, issue.endDate, issue.dueDate), historical: false,
        baseline: captured ? dates(captured.startDate, captured.endDate, null) : null,
      };
    }),
    ...historicalIssues.map((issue): GanttExportRow => ({
      kind: 'issue', kindLabel: null, title: issue.title, key: issue.key,
      ...projectLabel(baseline?.projectId), status: '삭제된 업무 기록', assignee: null,
      ...dates(null, null, null), baseline: dates(issue.startDate, issue.endDate, null), historical: true,
    })),
    ...milestones.map((milestone): GanttExportRow => {
      const captured = milestoneBaseline.get(milestone.id);
      return {
        kind: 'milestone', kindLabel: '마일스톤', title: milestone.title, key: null,
        ...projectLabel(milestone.projectId),
        status: milestone.status === 'reached' ? '달성' : '예정', assignee: assignee(milestone.ownerId),
        ...dates(null, null, milestone.date), baseline: captured ? dates(null, null, captured.date) : null, historical: false,
      };
    }),
    ...historicalMilestones.map((milestone): GanttExportRow => ({
      kind: 'milestone', kindLabel: '마일스톤', title: milestone.title, key: null,
      ...projectLabel(baseline?.projectId), status: '삭제된 마일스톤 기록', assignee: null,
      ...dates(null, null, null), baseline: dates(null, null, milestone.date), historical: true,
    })),
  ];

  return {
    title, capturedAt, range, today, nonworkingDates, filters, baselineName: baseline?.name ?? null, rows,
    dependencies: dependencies.flatMap(dependency => {
      const { id, predecessorId, successorId, type, lagDays } = dependency;
      const predecessorKey = issueKeys.get(predecessorId);
      const successorKey = issueKeys.get(successorId);
      if (!predecessorKey || !successorKey) return [];
      return [{ predecessorKey, successorKey, type, lagDays, check: findings ? findings.get(id) ?? { kind: 'valid' } : null }];
    }),
  };
}
