'use client';

import { useId, useMemo, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, ChartNoAxesCombined, LocateFixed, X } from 'lucide-react';
import type { ProjectScheduleAnalysis } from '../../shared/types';
import './schedule-analysis.css';

const PAGE_SIZE = 8;

interface ScheduleAnalysisProps {
  id: string;
  analysis: ProjectScheduleAnalysis | null;
  error: string;
  onClose: () => void;
  openIssue: (issueId: string) => void;
  canLocateIssue: (issueId: string) => boolean;
  onLocateIssue: (issueId: string) => void;
  onLocateFinish: (date: string) => void;
}

export function ScheduleAnalysis({
  id, analysis, error, onClose, openIssue, canLocateIssue, onLocateIssue, onLocateFinish,
}: ScheduleAnalysisProps) {
  const heading = useId();
  const tasks = useMemo(() => analysis ? [...analysis.tasks].sort((a, b) =>
    a.slackDays - b.slackDays || a.earlyStart.localeCompare(b.earlyStart) || a.key.localeCompare(b.key, 'ko', { numeric: true }),
  ) : [], [analysis]);
  const criticalCount = tasks.filter(task => task.critical).length;
  const finish = analysis?.projectedFinish;

  return <section id={id} className="gantt-analysis card" aria-labelledby={heading}>
    <header className="gantt-analysis-header">
      <div>
        <h2 id={heading}><ChartNoAxesCombined size={17} aria-hidden="true" />일정 여유 분석</h2>
        <p>저장된 날짜와 업무 연결을 기준으로 프로젝트 전체를 계산합니다.</p>
      </div>
      <button className="issue-icon-button" type="button" aria-label="일정 여유 분석 닫기" onClick={onClose}><X size={17} aria-hidden="true" /></button>
    </header>
    {error && <p className="gantt-analysis-notice" role="alert">{error}</p>}
    {analysis && <>
      <dl className="gantt-analysis-summary">
        <div><dt>예상 완료일</dt><dd>{finish ? <button className="gantt-analysis-finish" type="button" aria-label={`${finish} 예상 완료일의 간트 위치로 이동`} onClick={() => onLocateFinish(finish)}>
          <time dateTime={finish}>{finish}</time><LocateFixed size={14} aria-hidden="true" />
        </button> : '계산할 일정 없음'}</dd></div>
        <div><dt>여유 0근무일</dt><dd>{criticalCount.toLocaleString('ko-KR')}개</dd></div>
        <div><dt>분석한 업무</dt><dd>{tasks.length.toLocaleString('ko-KR')}개</dd></div>
      </dl>
      {analysis.partial && <p className="gantt-analysis-notice" role="status">
        {finish ? '표시한 완료일은 분석할 수 있는 업무의 예상 완료일입니다.' : '현재 입력으로 예상 완료일을 계산할 수 없습니다.'}
        {' '}아래에서 제외 사유를 확인하세요.
      </p>}
      {analysis.warnings.length > 0 && <ul className="gantt-analysis-warnings" aria-label="일정 여유 분석 참고">
        {analysis.warnings.map((warning, index) => <li key={index}>{warning}</li>)}
      </ul>}
      {tasks.length > 0 ? <>
        <p className="gantt-analysis-help">여유가 0근무일인 업무가 늦어지면 예상 완료일도 밀립니다. 보라색 테두리와 실선은 완료일에 영향을 주는 업무와 연결을 표시하며, 막대는 저장된 날짜에 그립니다.</p>
        <PagedAnalysisList title="업무별 여유" items={tasks} render={task => <>
          <div className="gantt-analysis-item-heading">
            <AnalysisIssueButton item={task} openIssue={openIssue} />
            <strong className={task.critical ? 'is-critical' : undefined}>여유 {task.slackDays.toLocaleString('ko-KR')}근무일</strong>
          </div>
          <dl className="gantt-analysis-dates">
            <div><dt>가장 이른 일정</dt><dd><PlanDates start={task.earlyStart} end={task.earlyFinish} /></dd></div>
            <div><dt>가장 늦은 일정</dt><dd><PlanDates start={task.latestStart} end={task.latestFinish} /></dd></div>
          </dl>
          {canLocateIssue(task.issueId) && <button type="button" className="gantt-analysis-locate" aria-label={`${task.key} 간트 위치로 이동`} onClick={() => onLocateIssue(task.issueId)}>
            <LocateFixed size={14} aria-hidden="true" />간트 위치
          </button>}
        </>} />
      </> : !analysis.partial && <p className="gantt-analysis-help">분석할 진행 대상 업무가 없습니다.</p>}
      {analysis.excluded.length > 0 && <PagedAnalysisList title="분석에서 제외된 업무" items={analysis.excluded} render={item => <>
        <AnalysisIssueButton item={item} openIssue={openIssue} />
        <p className="gantt-analysis-exclusion">{item.reason}</p>
      </>} />}
      {(analysis.completedCount > 0 || analysis.cancelledCount > 0) && <p className="gantt-analysis-help">
        완료 {analysis.completedCount.toLocaleString('ko-KR')}개 · 취소 {analysis.cancelledCount.toLocaleString('ko-KR')}개는 업무별 여유 계산에서 제외했습니다.
      </p>}
    </>}
  </section>;
}

function PlanDates({ start, end }: { start: string; end: string }) {
  return <><time dateTime={start}>{start}</time>{end !== start && <> ~ <time dateTime={end}>{end}</time></>}</>;
}

function AnalysisIssueButton({ item, openIssue }: {
  item: { issueId: string; key: string; title: string }; openIssue: ScheduleAnalysisProps['openIssue'];
}) {
  return <button className="gantt-analysis-issue" type="button" aria-label={`${item.key} 업무 열기`} onClick={() => openIssue(item.issueId)}>
    <small>{item.key}</small><span>{item.title}</span>
  </button>;
}

function PagedAnalysisList<T extends { issueId: string }>({ title, items, render }: {
  title: string; items: T[]; render: (item: T) => ReactNode;
}) {
  const [page, setPage] = useState(0);
  const heading = useId();
  const lastPage = Math.max(0, Math.ceil(items.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const offset = PAGE_SIZE * currentPage;

  return <section className="gantt-analysis-list" aria-labelledby={heading}>
    <h3 id={heading}>{title}</h3>
    <ul>
      {items.slice(offset, offset + PAGE_SIZE).map(item => <li key={item.issueId} data-analysis-issue-id={item.issueId}>{render(item)}</li>)}
    </ul>
    {lastPage > 0 && <nav className="gantt-analysis-pagination" aria-label={`${title} 페이지`}>
      <span aria-live="polite">{offset + 1}–{Math.min(offset + PAGE_SIZE, items.length)} / {items.length.toLocaleString('ko-KR')}</span>
      <button className="btn btn-ghost" type="button" aria-label={`${title} 이전 페이지`} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ArrowLeft size={15} aria-hidden="true" /></button>
      <button className="btn btn-ghost" type="button" aria-label={`${title} 다음 페이지`} disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}><ArrowRight size={15} aria-hidden="true" /></button>
    </nav>}
  </section>;
}
