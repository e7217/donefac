import type { CycleCompletionRecord, CycleCompletionRecordedIssue, RichContent } from '../shared/types.js';
import { deterministicCreationId } from './creation-request.js';

const groups = [
  ['done', '완료 업무'], ['cancelled', '취소 업무'], ['carry', '이월 업무'],
] as const;
const issueLimitPerGroup = 200;
const formatDate = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' });
const paragraph = (text: string): RichContent => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const heading = (text: string): RichContent => ({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text }] });

export function cycleRetrospectiveId(projectId: string, recordId: string): string {
  return deterministicCreationId(['cycle-retrospective', projectId, recordId]);
}

export function cycleRetrospectiveDraft(record: CycleCompletionRecord, hasActiveIssue: (id: string) => boolean) {
  const { cycle, completedAt, actorName, destination, counts } = record;
  const completed = formatDate.format(new Date(completedAt));
  const byGroup: Record<CycleCompletionRecordedIssue['disposition'], CycleCompletionRecordedIssue[]> = { done: [], cancelled: [], carry: [] };
  for (const issue of record.issues) {
    const group = byGroup[issue.disposition];
    if (group.length < issueLimitPerGroup) group.push(issue);
  }

  const content: RichContent[] = [
    heading('사이클 완료 기록'),
    paragraph(`완료 시각 ${completed} (서울) · 완료 작업자 ${actorName}`),
    paragraph(`당시 일정 ${cycle.startDate ?? '미정'} ~ ${cycle.endDate ?? '미정'} · 목표일 ${cycle.targetDate ?? '미정'}`),
    paragraph(`이월 대상 ${destination?.name ?? '백로그 (사이클 미지정)'}`),
  ];
  for (const [disposition, label] of groups) {
    content.push(heading(`${label} ${counts[disposition]}건`));
    const visible = byGroup[disposition];
    if (!visible.length) continue;
    content.push({ type: 'bulletList', content: visible.map(issue => {
      const blocks = [paragraph(`${issue.key} ${issue.title} · 당시 상태 ${issue.statusLabel} · 당시 담당 ${issue.assigneeName ?? '미지정'}`)];
      if (hasActiveIssue(issue.id)) blocks.push({ type: 'issueReference', attrs: { issueId: issue.id, label: '현재 업무 열기' } });
      return { type: 'listItem', content: blocks };
    }) });
    const omitted = counts[disposition] - visible.length;
    if (omitted) content.push(paragraph(`나머지 ${omitted}건은 프로젝트의 사이클 완료 기록에서 확인하세요.`));
  }
  content.push(heading('잘된 점'), { type: 'paragraph' }, heading('다음 사이클에서 개선할 점'), { type: 'paragraph' });
  return { title: `${cycle.name} 회고 · ${completed}`, content: { type: 'doc', content } satisfies RichContent };
}
