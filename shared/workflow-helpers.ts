import { STATUS, type Issue, type IssueRequiredField, type ProjectWorkflow, type WorkspaceSnapshot, type WorkflowStatus } from './types.js';
import { BASE_REQUIRED_FIELD_LABELS, fieldApplies, projectIssueSchema } from './issue-schema.js';

export const REQUIRED_FIELD_LABELS: Record<string, string> = BASE_REQUIRED_FIELD_LABELS;
export const STATUS_CATEGORY_LABELS = { backlog: '백로그', todo: '할 일', in_progress: '진행 중', review: '검토', done: '완료', cancelled: '취소' } as const;
export const MAX_WORKFLOW_WIP_LIMIT = 10_000;
export function defaultWorkflow(projectId: string, updatedAt = '1970-01-01T00:00:00.000Z'): ProjectWorkflow {
  const statuses = Object.entries(STATUS).map(([id, meta]) => ({ id, ...meta }));
  return { id: projectId, projectId, version: 1, initialStatusId: 'todo', statuses, transitions: statuses.flatMap(from => statuses.filter(to => to.id !== from.id).map(to => ({ from: from.id, to: to.id, issueTypes: [], requiredFields: [] }))), fieldRules: [], updatedAt };
}
type WorkflowData = Pick<WorkspaceSnapshot, 'workflows' | 'issueSchemas'>;
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
  const schema = projectIssueSchema(data, projectId);
  return [...new Set(fields)].filter(id => { if (!id.startsWith('custom:')) return true; const field = schema.fields.find(value => value.id === id.slice(7)); return Boolean(field && !field.archived && fieldApplies(field, issueType)); });
}
