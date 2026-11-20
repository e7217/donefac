import { projectIssueSchema } from './issue-schema.js';
import { issuePlanningLabel } from './planning-helpers.js';
import { PRIORITY, type Issue, type PlanningItem, type WorkspaceSnapshot } from './types.js';
import { projectStatuses } from './workflow-helpers.js';

type IssueCsvData = Pick<WorkspaceSnapshot, 'issueSchemas' | 'workflows' | 'projects' | 'users' | 'planningItems'>;

const headers = ['업무 키', '프로젝트', '제목', '유형', '상태', '우선순위', '담당자', '시작일', '종료일', '목표 마감일', '라벨', '사이클', '모듈', '릴리스'];
const spreadsheetPrefix = /^\p{Cc}|^[\p{White_Space}\p{Cc}\p{Default_Ignorable_Code_Point}]*[=+\-@＝＋－＠−]/u;

function csvRow(cells: readonly string[]): string {
  return cells.map(cell => {
    const literal = spreadsheetPrefix.test(cell) ? `'${cell}` : cell;
    return `"${literal.replaceAll('"', '""')}"`;
  }).join(',');
}

export function formatIssueCsv(data: IssueCsvData, issues: readonly Issue[]): string {
  const projectNames = new Map(data.projects.map(project => [project.id, project.name]));
  const assigneeNames = new Map(data.users.map(user => [user.id, user.name]));
  const plansByProject = new Map<string, PlanningItem[]>();
  for (const item of data.planningItems ?? []) {
    const plans = plansByProject.get(item.projectId);
    if (plans) plans.push(item);
    else plansByProject.set(item.projectId, [item]);
  }
  const projectLabels = new Map([...new Set(issues.map(issue => issue.projectId))].map(projectId => [projectId, {
    types: new Map(projectIssueSchema(data, projectId).issueTypes.map(type => [type.id, type.name])),
    statuses: new Map(projectStatuses(data, projectId).map(status => [status.id, status.label])),
    planningItems: plansByProject.get(projectId),
  }]));

  const rows = issues.map(issue => {
    const labels = projectLabels.get(issue.projectId)!;
    return csvRow([
      issue.key, projectNames.get(issue.projectId) ?? '', issue.title,
      labels.types.get(issue.type) ?? '알 수 없는 유형', labels.statuses.get(issue.status) ?? '알 수 없는 상태',
      PRIORITY[issue.priority], issue.assigneeId ? assigneeNames.get(issue.assigneeId) ?? '' : '',
      issue.startDate ?? '', issue.endDate ?? '', issue.dueDate ?? '', issue.labels.join(', '),
      issuePlanningLabel(labels, issue, 'cycle'), issuePlanningLabel(labels, issue, 'module'), issuePlanningLabel(labels, issue, 'release'),
    ]);
  });
  return `\uFEFF${[csvRow(headers), ...rows].join('\r\n')}\r\n`;
}
