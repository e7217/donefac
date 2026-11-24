import type { DecisionFollowUpDraftRequest, DecisionFollowUpPage, RichContent } from '../shared/types.js';

type DraftDetails = {
  page: DecisionFollowUpPage;
  items: DecisionFollowUpPage['items'];
  filters: { status: NonNullable<DecisionFollowUpDraftRequest['status']>; assigneeId: string | null; searchTerm: string; unscheduledOnly?: boolean };
  projectNames: ReadonlyMap<string, string>;
  assigneeNames: ReadonlyMap<string, string>;
  excerpts: ReadonlyMap<string, string>;
  href: string;
};

const statusLabels = { open: '미완료', closed: '종료', all: '전체 상태' };
const numberLabel = (value: number) => value.toLocaleString('ko-KR');
const text = (value: string): RichContent => ({ type: 'text', text: value });
const paragraph = (value: string): RichContent => ({ type: 'paragraph', content: [text(value)] });
const heading = (value: string, level: 2 | 3 = 2): RichContent => ({ type: 'heading', attrs: { level }, content: [text(value)] });
const documentLabel = (title: string) => title || '제목 없는 문서';

export function buildDecisionFollowUpDraftContent({ page, items, filters, projectNames, assigneeNames, excerpts, href }: DraftDetails): {
  content: RichContent; issueIds: string[];
} {
  const issues = new Map<string, string>();
  const documents = new Map<string, string>();
  const projectLabel = (id: string) => projectNames.get(id) ?? '프로젝트 정보 없음';
  const assigneeLabel = (id: string | null) => id === null ? '미지정' : assigneeNames.get(id) ?? '미지정';
  const scope = page.projectId === null ? '전체 프로젝트' : projectLabel(page.projectId);
  const assigneeFilter = filters.assigneeId === null ? '전체 담당자' : assigneeLabel(filters.assigneeId);
  const captured = page.generatedAt.replace('T', ' ').replace(/Z$/, ' UTC');
  const recorded = items.length < page.items.length
    ? `결정 근거 ${numberLabel(page.total)}건 중 현재 보고서 페이지에서 선택한 ${numberLabel(items.length)}건을 기록했습니다.`
    : `결정 근거 ${numberLabel(page.total)}건 중 ${numberLabel(page.offset + 1)}–${numberLabel(page.offset + items.length)}번째 ${numberLabel(items.length)}건을 기록했습니다.`;
  const content: RichContent[] = [
    paragraph(`보고서 기준 시각 ${captured}`),
    paragraph(`프로젝트 ${scope} · 상태 ${statusLabels[filters.status]} · 담당자 ${assigneeFilter}`),
    ...(filters.searchTerm ? [paragraph(`검색어 ${filters.searchTerm}`)] : []),
    ...(filters.unscheduledOnly ? [paragraph('일정 미정만')] : []),
    { type: 'paragraph', content: [{ ...text('결정 후속 업무 보고서 열기'), marks: [{ type: 'link', attrs: { href, target: '_self' } }] }, text(' (현재 상태)')] },
    heading('결정 후속 업무'),
    paragraph(recorded),
  ];

  for (const { linkId, issue, document, source } of items) {
    const deadlineLabel = issue.deadlineSource === 'endDate' ? '계획 종료일' : '목표 마감일';
    const space = document.projectId === null ? '팀 공통 문서' : projectLabel(document.projectId);
    const issueLabel = `${issue.key} · ${issue.title}`;
    const excerpt = excerpts.get(linkId);
    content.push(
      heading(issueLabel, 3),
      paragraph(`업무 프로젝트 ${projectLabel(issue.projectId)} · 상태 ${issue.statusLabel} · 담당자 ${assigneeLabel(issue.assigneeId)} · ${deadlineLabel} ${issue.deadline ?? '미정'}`),
      paragraph(`계획 시작일 ${issue.startDate ?? '미정'} · 계획 종료일 ${issue.endDate ?? '미정'}`),
      paragraph(`원문 문서 ${documentLabel(document.title)} · ${space}`),
      paragraph(`고정 저장본 ${documentLabel(source.title)} · 버전 ${source.version} · ${source.createdAt}`),
      excerpt ? { type: 'blockquote', content: [paragraph(excerpt)] } : paragraph('저장된 결정 근거를 확인할 수 없습니다.'),
    );
    issues.set(issue.id, issueLabel);
    documents.set(document.id, documentLabel(document.title));
  }

  if (issues.size) {
    content.push(heading('관련 업무'), ...Array.from(issues, ([issueId, label]) => ({
      type: 'issueReference', attrs: { issueId, label: label.slice(0, 300) },
    })));
  }
  if (documents.size) {
    content.push(heading('원문 문서'), ...Array.from(documents, ([documentId, label]) => ({
      type: 'documentReference', attrs: { documentId, label: label.slice(0, 300) },
    })));
  }
  content.push(heading('회의 메모'), { type: 'paragraph' });
  return { content: { type: 'doc', content }, issueIds: [...issues.keys()] };
}
