export const STATUS = {
  backlog: { label: '백로그', color: '#8b93a5' },
  todo: { label: '할 일', color: '#677386' },
  in_progress: { label: '진행 중', color: '#5778ef' },
  review: { label: '검토', color: '#a175d3' },
  done: { label: '완료', color: '#31a27e' },
  cancelled: { label: '취소', color: '#a2a8b4' },
} as const;
export type IssueStatus = keyof typeof STATUS;
export const PRIORITY = { urgent: '긴급', high: '높음', medium: '보통', low: '낮음' } as const;
export type Priority = keyof typeof PRIORITY;
export const ISSUE_TYPES = ['큰틀', '작업', '부작업', '버그', '개선', '신규', '요구사항', '회의', '기획'] as const;
export interface User { id: string; name: string; email: string; color: string }
export interface Project { id: string; key: string; name: string; description: string; color: string; createdAt: string }
export interface Issue {
  id: string; key: string; projectId: string; title: string; description: string;
  type: string; status: IssueStatus; priority: Priority; assigneeId: string | null;
  collaboratorIds: string[]; parentId: string | null; labels: string[];
  startDate: string | null; endDate: string | null; dueDate: string | null;
  estimate: number | null; cycle: string | null; module: string | null; release: string | null;
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
export interface WorkspaceSnapshot {
  projects: Project[]; users: User[]; issues: Issue[]; documents: DocPage[];
  dependencies: Dependency[]; resourceLinks: ResourceLink[]; activities: Activity[]; gitlabLinks: GitlabLink[];
}
export interface ScheduleChange { id: string; key: string; title: string; version: number; fromStart: string | null; fromEnd: string | null; toStart: string | null; toEnd: string | null }
export interface SchedulePreview { changes: ScheduleChange[]; warnings: string[] }
export interface FeatureProps {
  data: WorkspaceSnapshot; projectId: string; actorId: string;
  refresh: () => Promise<void>; notify: (message: string, kind?: 'success' | 'error') => void;
  openIssue: (id: string) => void; openDocument: (id: string) => void;
}
