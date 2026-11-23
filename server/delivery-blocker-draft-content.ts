import { DEPENDENCY_LABELS, SCHEDULE_DATE_LABELS } from '../shared/schedule-dependencies.js';
import {
  PRIORITY, type DeliveryBlockerIssue, type DeliveryBlockerReason, type DeliveryBlockerReport, type RichContent,
} from '../shared/types.js';

const ISSUE_LIMIT = 20;
const EXAMPLE_LIMIT = 3;
const REFERENCE_LIMIT = 30;
const REASON_LABELS: Record<DeliveryBlockerReason, string> = {
  issue_block: '수동 차단',
  schedule_conflict: '간트 일정 충돌',
  gitlab: 'GitLab 조치',
  missing_schedule: '일정 미정',
  after_release_date: '릴리스 기한 초과',
};

const numberLabel = (value: number) => value.toLocaleString('ko-KR');
const text = (value: string): RichContent => ({ type: 'text', text: value });
const paragraph = (value: string): RichContent => ({ type: 'paragraph', content: [text(value)] });
const heading = (value: string, level: 2 | 3 = 2): RichContent => ({ type: 'heading', attrs: { level }, content: [text(value)] });
const issueLabel = (issue: DeliveryBlockerIssue) => `${issue.key} · ${issue.title}`;

function causeDetails(label: string, total: number, examples: string[]): RichContent[] {
  if (!total) return [];
  const content = [paragraph(`${label} ${numberLabel(total)}건`)];
  if (examples.length) {
    content.push({
      type: 'bulletList',
      content: examples.map(example => ({ type: 'listItem', content: [paragraph(example)] })),
    });
  }
  if (total > examples.length) content.push(paragraph(`예시 외 ${numberLabel(total - examples.length)}건`));
  return content;
}

/** Preserve the reviewed evidence as editable text and add live issue references separately. */
export function buildDeliveryBlockerDraftContent(
  report: DeliveryBlockerReport, sourceHref: string,
): { content: RichContent; issueIds: string[] } {
  const rows = report.items.slice(0, ISSUE_LIMIT);
  const sources: DeliveryBlockerIssue[] = [];
  const captured = new Date(report.generatedAt);
  const asOf = Number.isFinite(captured.valueOf())
    ? captured.toISOString().replace('T', ' ').replace(/Z$/, ' UTC')
    : report.generatedAt;
  const scope = report.savedView?.name ?? (report.release ? '릴리스 연결 업무' : '프로젝트 전체');
  const reason = report.reason ? REASON_LABELS[report.reason] : '전체 원인';
  const { open, affected, reasons } = report.counts;
  const omitted = report.total - rows.length;
  const release = report.release;
  const releaseDeadlineLabel = release?.deadlineSource === 'endDate' ? '계획 종료일' : '목표일';
  const content: RichContent[] = [
    paragraph(`보고서 기준 시각 ${asOf}`),
    paragraph(`보기 ${scope} · 원인 ${reason}`),
    ...(release ? [paragraph(`릴리스 ${release.name} · ${release.deadline ? `${releaseDeadlineLabel} ${release.deadline}` : '기준일 미정'}`)] : []),
    { type: 'paragraph', content: [{
      ...text('진행 차단 보고서 열기'), marks: [{ type: 'link', attrs: { href: sourceHref, target: '_self' } }],
    }, text(' (현재 상태)')] },
    heading('집계'),
    paragraph(`미완료 업무 ${numberLabel(open)}개 · 차단된 업무 ${numberLabel(affected)}개`),
    paragraph(`수동 차단 ${numberLabel(reasons.issue_block)}개 · 간트 일정 충돌 ${numberLabel(reasons.schedule_conflict)}개 · GitLab 조치 ${numberLabel(reasons.gitlab)}개`),
    ...(release ? [paragraph(`${REASON_LABELS.missing_schedule} ${numberLabel(reasons.missing_schedule ?? 0)}개 · ${REASON_LABELS.after_release_date} ${numberLabel(reasons.after_release_date ?? 0)}개`)] : []),
    heading('차단 업무'),
    paragraph(`선택한 조건에 해당하는 업무 ${numberLabel(report.total)}개 중 ${numberLabel(rows.length)}개를 기록했습니다.`),
  ];
  if (omitted > 0) content.push(paragraph(`초안에서 생략한 업무 ${numberLabel(omitted)}개`));

  for (const { issue, deadline, priority, blockers, scheduleConflicts, gitlab, releaseSchedule } of rows) {
    const sourceLabel = deadline?.source === 'endDate' ? '종료일' : '목표 마감일';
    content.push(
      heading(issueLabel(issue), 3),
      paragraph(`상태 ${issue.statusLabel} · 담당자 ${issue.assigneeName ?? '미지정'} · 우선순위 ${PRIORITY[priority]} · ${sourceLabel} ${deadline?.value ?? '미정'}`),
    );

    const blockerExamples = blockers.items.slice(0, EXAMPLE_LIMIT);
    sources.push(...blockerExamples);
    content.push(...causeDetails(REASON_LABELS.issue_block, blockers.total, blockerExamples.map(issueLabel)));

    const conflicts = scheduleConflicts.items.slice(0, EXAMPLE_LIMIT);
    sources.push(...conflicts.map(conflict => conflict.predecessor));
    content.push(...causeDetails(REASON_LABELS.schedule_conflict, scheduleConflicts.total, conflicts.map(conflict => {
      const { predecessor, endpoint, scheduledDate, requiredDate, type, lagDays } = conflict;
      const lag = `${lagDays > 0 ? '+' : ''}${lagDays}근무일`;
      return `${issueLabel(predecessor)} · ${DEPENDENCY_LABELS[type]} (${type}) · ${lag} · ${SCHEDULE_DATE_LABELS[endpoint]} ${scheduledDate} · ${requiredDate}부터 가능`;
    })));

    const gitlabActions: string[] = [];
    if (gitlab.blockedMergeRequests) gitlabActions.push(`병합 확인이 필요한 MR ${numberLabel(gitlab.blockedMergeRequests)}건`);
    if (gitlab.failedPipelines) gitlabActions.push(`실패한 파이프라인 ${numberLabel(gitlab.failedPipelines)}건`);
    if (gitlabActions.length) content.push(paragraph(`${REASON_LABELS.gitlab} · ${gitlabActions.join(' · ')}`));
    if (releaseSchedule) {
      content.push(paragraph(`계획 일정 · 시작일 ${releaseSchedule.startDate ?? '미정'} · 종료일 ${releaseSchedule.endDate ?? '미정'}`));
      if (releaseSchedule.afterDeadline && release?.deadline) {
        content.push(paragraph(`${REASON_LABELS.after_release_date} · ${releaseDeadlineLabel} ${release.deadline}`));
      }
    }
  }

  const references = new Map<string, DeliveryBlockerIssue>();
  for (const issue of [...rows.map(row => row.issue), ...sources]) {
    if (references.size === REFERENCE_LIMIT) break;
    if (!references.has(issue.id)) references.set(issue.id, issue);
  }
  if (references.size) {
    content.push(heading('관련 업무'));
    for (const issue of references.values()) {
      content.push({ type: 'issueReference', attrs: { issueId: issue.id, label: `${issue.key} ${issue.title}`.slice(0, 300) } });
    }
  }
  content.push(heading('회의 메모'), { type: 'paragraph' });
  return { content: { type: 'doc', content }, issueIds: [...references.keys()] };
}
