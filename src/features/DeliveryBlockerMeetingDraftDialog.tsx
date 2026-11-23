'use client';

import type { DeliveryBlockerReport, FeatureProps } from '../../shared/types';
import { ReportMeetingDraftDialog } from './ReportMeetingDraftDialog';

type Props = Pick<FeatureProps, 'actorId' | 'refresh' | 'notify' | 'openDocument'> & {
  report: DeliveryBlockerReport;
  reasonLabel: string;
  reloadReport: () => Promise<DeliveryBlockerReport | null>;
  onClose: () => void;
};

const ROW_LIMIT = 20;

export function DeliveryBlockerMeetingDraftDialog({ report, reasonLabel, ...actions }: Props) {
  return <ReportMeetingDraftDialog {...actions} report={report}
    initialTitle={`${report.release ? '릴리스 준비 회의' : '진행 차단 회의'} · ${report.generatedAt.slice(0, 10)}`}
    initialDestinationId={report.projectId} savePath={`/projects/${encodeURIComponent(report.projectId)}/delivery-blockers/meeting-draft`}
    requestFields={scope => ({
      ...(scope.savedView ? { savedViewId: scope.savedView.id } : {}),
      ...(scope.reason ? { reason: scope.reason } : {}),
      ...(scope.release ? { releaseId: scope.release.id } : {}),
    })}
    emptyNotice={scope => scope.release ? '이 조건에서 준비를 확인할 업무가 없습니다.' : '이 조건에 해당하는 차단 업무가 없습니다.'}
    renderReport={scope => <DeliveryBlockerDraftPreview scope={scope} reasonLabel={reasonLabel} />} />;
}

function DeliveryBlockerDraftPreview({ scope, reasonLabel }: { scope: DeliveryBlockerReport; reasonLabel: string }) {
  const draftCount = Math.min(scope.total, ROW_LIMIT);
  return <>
    <dl aria-label="회의 초안 조건">
      {scope.release && <>
        <div><dt>릴리스</dt><dd>{scope.release.name}</dd></div>
        <div><dt>{scope.release.deadlineSource === 'endDate' ? '릴리스 종료일' : scope.release.deadline ? '릴리스 목표일' : '릴리스 기한'}</dt>
          <dd>{scope.release.deadline ? <time dateTime={scope.release.deadline}>{scope.release.deadline}</time> : '미정'}</dd>
        </div>
      </>}
      <div><dt>공유 보기</dt><dd>{scope.savedView?.name ?? '프로젝트 전체'}</dd></div>
      <div><dt>차단 원인</dt><dd>{reasonLabel}</dd></div>
      <div><dt>대상 업무</dt><dd>{scope.total.toLocaleString('ko-KR')}개</dd></div>
    </dl>
    {scope.total > 0 && <p>보고서 순서대로 최대 {ROW_LIMIT}개 업무를 문서에 담습니다.</p>}
    {draftCount > 0 && <details>
      <summary>요약에 포함할 업무 {draftCount}개</summary>
      <ol>{scope.items.slice(0, ROW_LIMIT).map(row => <li key={row.issue.id}>
        <strong>{row.issue.key} · {row.issue.title}</strong>
        <p>{[
          row.blockers.total ? `업무 차단 ${row.blockers.total}건` : '',
          row.scheduleConflicts.total ? `간트 일정 충돌 ${row.scheduleConflicts.total}건` : '',
          row.gitlab.blockedMergeRequests ? `병합 확인이 필요한 MR ${row.gitlab.blockedMergeRequests}건` : '',
          row.gitlab.failedPipelines ? `실패한 파이프라인 ${row.gitlab.failedPipelines}건` : '',
          row.releaseSchedule?.missing.includes('startDate') ? '시작일 미정' : '',
          row.releaseSchedule?.missing.includes('endDate') ? '종료일 미정' : '',
          row.releaseSchedule?.afterDeadline ? `릴리스 기한 초과 · 종료일 ${row.releaseSchedule.endDate}` : '',
        ].filter(Boolean).join(' · ')}</p>
      </li>)}</ol>
    </details>}
  </>;
}
