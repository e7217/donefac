import type { ConfluenceMigrationDocumentField, JiraMigrationIssueField, SourceReconciliationPrimaryField } from '../../shared/types';

export const jiraRefreshFieldLabels: Record<JiraMigrationIssueField, string> = {
  title: '제목', description: '설명', status: '상태', type: '업무 유형', priority: '우선순위', assigneeId: '담당자', reporterId: '요청자', labels: '라벨',
  startDate: '시작일', endDate: '종료일', dueDate: '마감일', estimate: '예상 작업량', plannedEffortMinutes: '계획 작업 시간 (분)', parentId: '상위 업무',
};

export const confluenceRefreshFieldLabels: Record<ConfluenceMigrationDocumentField, string> = {
  title: '제목', content: '본문', labels: '라벨', parentId: '상위 문서',
};

export function primaryFieldLabel(field: SourceReconciliationPrimaryField) {
  return field === 'content' ? confluenceRefreshFieldLabels.content : jiraRefreshFieldLabels[field];
}
