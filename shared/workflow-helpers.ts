import { STATUS, type Issue, type IssueRequiredField, type ProjectWorkflow, type WorkspaceSnapshot, type WorkflowStatus } from './types.js';

export const REQUIRED_FIELD_LABELS: Record<IssueRequiredField, string> = { title: '제목', description: '설명', assigneeId: '담당자', collaboratorIds: '참여자', startDate: '시작일', endDate: '종료일', dueDate: '목표 마감일', estimate: '예상 소요', labels: '라벨', parentId: '상위 업무', cycle: '사이클', module: '모듈', release: '릴리스' };
export const STATUS_CATEGORY_LABELS = { backlog: '백로그', todo: '할 일', in_progress: '진행 중', review: '검토', done: '완료', cancelled: '취소' } as const;
export function defaultWorkflow(projectId: string, updatedAt = '1970-01-01T00:00:00.000Z'): ProjectWorkflow {
  const statuses = Object.entries(STATUS).map(([id, meta]) => ({ id, ...meta }));
  return { id: projectId, projectId, version: 1, initialStatusId: 'todo', statuses, transitions: statuses.flatMap(from => statuses.filter(to => to.id !== from.id).map(to => ({ from: from.id, to: to.id, issueTypes: [], requiredFields: [] }))), fieldRules: [], updatedAt };
}
type WorkflowData = Pick<WorkspaceSnapshot, 'workflows'>;
export function projectWorkflow(data: WorkflowData, projectId: string) { return data.workflows?.find(workflow => workflow.projectId === projectId) || defaultWorkflow(projectId); }
export function projectStatuses(data: WorkflowData, projectId: string): WorkflowStatus[] { return projectWorkflow(data, projectId).statuses; }
export function statusMeta(data: WorkflowData, projectId: string, statusId: string): WorkflowStatus { return projectStatuses(data, projectId).find(status => status.id === statusId) || { id: statusId, label: statusId || '알 수 없는 상태', color: '#8b93a5', category: 'backlog' }; }
export function isTerminalStatus(data: WorkflowData, projectId: string, statusId: string) { return ['done', 'cancelled'].includes(statusMeta(data, projectId, statusId).category); }
export function allowedNextStatuses(data: WorkflowData, issue: Pick<Issue, 'projectId' | 'status' | 'type'>, issueType = issue.type): WorkflowStatus[] {
  const workflow = projectWorkflow(data, issue.projectId);
  const allowed = new Set([issue.status, ...workflow.transitions.filter(edge => edge.from === issue.status && (!edge.issueTypes.length || edge.issueTypes.includes(issueType))).map(edge => edge.to)]);
  return workflow.statuses.filter(status => allowed.has(status.id));
}
export function requiredFieldsFor(data: WorkflowData, projectId: string, issueType: string, statusId: string, fromStatus?: string): IssueRequiredField[] {
  const workflow = projectWorkflow(data, projectId);
  const fields = workflow.fieldRules.filter(rule => (rule.issueType === '*' || rule.issueType === issueType) && rule.statusId === statusId).flatMap(rule => rule.requiredFields);
  if (fromStatus && fromStatus !== statusId) fields.push(...workflow.transitions.filter(edge => edge.from === fromStatus && edge.to === statusId && (!edge.issueTypes.length || edge.issueTypes.includes(issueType))).flatMap(edge => edge.requiredFields));
  return [...new Set(fields)];
}
