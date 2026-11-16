export type StatusCategory = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done' | 'cancelled';
export interface WorkflowStatus { id: string; label: string; color: string; category: StatusCategory }
export const STATUS: Record<string, Omit<WorkflowStatus, 'id'>> = {
  backlog: { label: '백로그', color: '#8b93a5', category: 'backlog' },
  todo: { label: '할 일', color: '#677386', category: 'todo' },
  in_progress: { label: '진행 중', color: '#5778ef', category: 'in_progress' },
  review: { label: '검토', color: '#a175d3', category: 'review' },
  done: { label: '완료', color: '#31a27e', category: 'done' },
  cancelled: { label: '취소', color: '#a2a8b4', category: 'cancelled' },
};
export type IssueStatus = string;
export const PRIORITY = { urgent: '긴급', high: '높음', medium: '보통', low: '낮음' } as const;
export type Priority = keyof typeof PRIORITY;
export const ISSUE_TYPES = ['큰틀', '작업', '부작업', '버그', '개선', '신규', '요구사항', '회의', '기획'] as const;
export interface User { id: string; name: string; email: string; color: string }
export interface Project { id: string; key: string; name: string; description: string; color: string; createdAt: string }
export type PlanningKind = 'cycle' | 'module' | 'release';
export type PlanningStatus = 'planned' | 'active' | 'completed' | 'archived';
export interface PlanningItem {
  id: string; projectId: string; kind: PlanningKind; name: string; description: string;
  status: PlanningStatus; ownerId: string | null; startDate: string | null; endDate: string | null; targetDate: string | null;
  version: number; createdAt: string; updatedAt: string;
}
export type ApiKeyAccess = 'read' | 'write';
export interface ApiKeyRecord {
  id: string; name: string; prefix: string; actorId: string; access: ApiKeyAccess; projectIds: string[] | null;
  version: number; createdAt: string; expiresAt: string | null; lastUsedAt: string | null; revokedAt: string | null;
}
export interface ApiKeyCreated { key: ApiKeyRecord; token: string }
export interface CalendarException { date: string; isWorking: boolean; label: string }
export interface WorkCalendar { id: string; projectId: string; name: string; workingWeekdays: number[]; exceptions: CalendarException[]; version: number; updatedAt: string }
export interface Milestone { id: string; projectId: string; title: string; description: string; date: string; status: 'open' | 'reached'; ownerId: string | null; issueIds: string[]; version: number; createdAt: string; updatedAt: string }
export interface BaselineIssue { issueId: string; key: string; title: string; startDate: string | null; endDate: string | null; sourceVersion: number }
export interface BaselineMilestone { milestoneId: string; title: string; date: string; status: 'open' | 'reached'; sourceVersion: number }
export interface ScheduleBaseline { id: string; projectId: string; name: string; description: string; authorId: string; version: number; createdAt: string; calendar: WorkCalendar; issues: BaselineIssue[]; milestones: BaselineMilestone[] }
export interface Issue {
  id: string; key: string; projectId: string; title: string; description: string;
  type: string; status: IssueStatus; priority: Priority; assigneeId: string | null;
  collaboratorIds: string[]; parentId: string | null; labels: string[];
  startDate: string | null; endDate: string | null; dueDate: string | null;
  estimate: number | null; cycle: string | null; module: string | null; release: string | null;
  cycleId?: string | null; moduleId?: string | null; releaseId?: string | null;
  version: number; createdAt: string; updatedAt: string; completedAt: string | null;
}
export interface RichContent { type: string; content?: RichContent[]; text?: string; attrs?: Record<string, unknown>; marks?: {type: string; attrs?: Record<string, unknown>}[] }
export interface DocPage {
  id: string; projectId: string | null; parentId: string | null; title: string;
  content: RichContent; plainText: string; icon: string; status: 'draft' | 'published';
  version: number; authorId: string; createdAt: string; updatedAt: string;
}
export interface DocRevision { id: string; documentId: string; version: number; title: string; content: RichContent; plainText: string; authorId: string; createdAt: string; summary: string }
export interface Dependency { id: string; predecessorId: string; successorId: string; type: 'FS'; lagDays: number }
export interface ResourceLink { id: string; issueId: string; documentId: string; kind: string }
export interface Comment { id: string; resourceType: 'issue' | 'document'; resourceId: string; authorId: string; body: string; createdAt: string }
export interface Attachment { id: string; resourceType: 'issue' | 'document'; resourceId: string; filename: string; mimeType: string; size: number; sha256: string; authorId: string; createdAt: string }
export interface Activity { id: string; resourceType: string; resourceId: string; actorId: string; action: string; detail: string; createdAt: string }
export interface GitlabLink { id: string; issueId: string; projectId: number; iid: number; kind: 'merge_request' | 'commit' | 'pipeline'; title: string; webUrl: string; state: string; updatedAt: string }
export interface GitlabSettings { baseUrl: string; projectIds: number[]; tokenConfigured: boolean; webhookSecretConfigured: boolean; lastSyncAt: string | null; lastError: string | null }
export type IssueRequiredField = 'title' | 'description' | 'assigneeId' | 'collaboratorIds' | 'startDate' | 'endDate' | 'dueDate' | 'estimate' | 'labels' | 'parentId' | 'cycle' | 'module' | 'release';
export interface WorkflowTransition { from: string; to: string; issueTypes: string[]; requiredFields: IssueRequiredField[] }
export interface WorkflowFieldRule { issueType: string; statusId: string; requiredFields: IssueRequiredField[] }
export interface ProjectWorkflow { id: string; projectId: string; version: number; initialStatusId: string; statuses: WorkflowStatus[]; transitions: WorkflowTransition[]; fieldRules: WorkflowFieldRule[]; updatedAt: string }
export interface SavedViewState { layout: 'list' | 'board'; filters: { query: string; status: string; assigneeId: string; type: string } }
export interface SavedView extends SavedViewState { id: string; projectId: string; name: string; authorId: string; version: number; createdAt: string; updatedAt: string }
export interface WorkspaceSnapshot {
  projects: Project[]; users: User[]; issues: Issue[]; documents: DocPage[]; workflows?: ProjectWorkflow[];
  dependencies: Dependency[]; resourceLinks: ResourceLink[]; activities: Activity[]; gitlabLinks: GitlabLink[]; savedViews?: SavedView[];
  planningItems?: PlanningItem[];
  calendars?: WorkCalendar[]; milestones?: Milestone[]; baselines?: ScheduleBaseline[];
}
export interface ScheduleChange { id: string; key: string; title: string; version: number; fromStart: string | null; fromEnd: string | null; toStart: string | null; toEnd: string | null }
export interface SchedulePreview { changes: ScheduleChange[]; warnings: string[]; calendarVersions?: Record<string, number>; previewId?: string; blocking?: string[]; expiresAt?: string }
export interface AutomaticSchedulePreview extends SchedulePreview { previewId: string; blocking: string[]; expiresAt: string }
export interface FeatureProps {
  data: WorkspaceSnapshot; projectId: string; actorId: string;
  refresh: () => Promise<void>; notify: (message: string, kind?: 'success' | 'error') => void;
  openIssue: (id: string) => void; openDocument: (id: string) => void;
}
