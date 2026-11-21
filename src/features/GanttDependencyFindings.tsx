'use client';

import { useId, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, CalendarDays, Link2, TriangleAlert, X } from 'lucide-react';
import {
  isDependencyLag, isDependencyType, SCHEDULE_DATE_LABELS,
  type DependencyScheduleCheck, type ScheduleDependencyEndpoint,
} from '../../shared/schedule-dependencies';
import type { Dependency, Issue } from '../../shared/types';
import { dependencyLabel } from './schedule-utils';
import './gantt-dependency-findings.css';

export interface GanttDependencyFinding {
  dependency: Dependency;
  predecessor: Issue;
  successor: Issue;
  check: Exclude<DependencyScheduleCheck, { kind: 'valid' }>;
}

interface GanttDependencyFindingsProps {
  id: string;
  findings: readonly GanttDependencyFinding[];
  onClose: () => void;
  onLocateDate: (issueId: string, endpoint: ScheduleDependencyEndpoint) => void;
  onEditLink: (dependency: Dependency, opener: HTMLButtonElement) => void;
  disabled: boolean;
  focused?: boolean;
  allProjects?: boolean;
}

const PAGE_SIZE = 8;
const FINDING_LABELS = { conflict: '충돌', missing: '날짜 미정', invalid: '확인 필요' } as const;
const FINDING_KINDS = ['conflict', 'missing', 'invalid'] as const;

export function GanttDependencyFindings({
  id, findings, onClose, onLocateDate, onEditLink, disabled, focused, allProjects,
}: GanttDependencyFindingsProps) {
  const heading = useId();
  const [page, setPage] = useState(0);
  const { counts, ordered } = useMemo(() => {
    const groups: Record<GanttDependencyFinding['check']['kind'], GanttDependencyFinding[]> = {
      conflict: [], missing: [], invalid: [],
    };
    for (const finding of findings) groups[finding.check.kind].push(finding);
    return {
      counts: FINDING_KINDS.map(kind => ({ kind, count: groups[kind].length })),
      ordered: FINDING_KINDS.flatMap(kind => groups[kind]),
    };
  }, [findings]);
  const lastPage = Math.max(0, Math.ceil(ordered.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const offset = currentPage * PAGE_SIZE;

  return <section id={id} className="gantt-findings card" aria-labelledby={heading}>
    <header className="gantt-findings-header">
      <div>
        <h2 id={heading}><TriangleAlert size={17} aria-hidden="true" />일정 충돌</h2>
        <p>{focused ? '현재 선후행 흐름의 저장된 날짜와 연결을 점검합니다.' : allProjects
          ? '각 프로젝트의 달력으로 업무 날짜와 선후행 연결을 점검합니다.' : '프로젝트 전체 업무의 저장된 날짜와 연결을 점검합니다.'}</p>
      </div>
      <button className="issue-icon-button" type="button" aria-label="일정 충돌 닫기" onClick={onClose}>
        <X size={17} aria-hidden="true" />
      </button>
    </header>
    <dl className="gantt-findings-summary" aria-label="일정 점검 요약">
      {counts.map(({ kind, count }) => <div key={kind} className={kind === 'conflict' && count > 0 ? 'has-conflicts' : undefined}>
        <dt>{FINDING_LABELS[kind]}{' '}</dt><dd>{count.toLocaleString('ko-KR')}건</dd>
      </div>)}
    </dl>
    {ordered.length > 0 ? <>
      <ul className="gantt-findings-list" aria-label="일정 점검 항목" role="list">
        {ordered.slice(offset, offset + PAGE_SIZE).map(finding => <li key={finding.dependency.id}>
          <FindingDetails finding={finding} onLocateDate={onLocateDate} onEditLink={onEditLink} disabled={disabled} />
        </li>)}
      </ul>
      {lastPage > 0 && <nav className="gantt-findings-pagination" aria-label="일정 점검 항목 페이지">
        <span aria-live="polite">{offset + 1}–{Math.min(offset + PAGE_SIZE, ordered.length)} / {ordered.length.toLocaleString('ko-KR')}</span>
        <button type="button" className="btn btn-ghost" aria-label="일정 점검 항목 이전 페이지" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
          <ArrowLeft size={15} aria-hidden="true" />
        </button>
        <button type="button" className="btn btn-ghost" aria-label="일정 점검 항목 다음 페이지" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>
          <ArrowRight size={15} aria-hidden="true" />
        </button>
      </nav>}
    </> : <p className="gantt-findings-empty" role="status">현재 충돌이나 날짜 확인이 필요한 연결이 없습니다.</p>}
  </section>;
}

function FindingDetails({ finding, onLocateDate, onEditLink, disabled }: {
  finding: GanttDependencyFinding;
} & Pick<GanttDependencyFindingsProps, 'onLocateDate' | 'onEditLink' | 'disabled'>) {
  const { dependency, predecessor, successor, check } = finding;
  return <>
    <div className="gantt-findings-item-heading">
      <h3>{predecessor.key} <span aria-hidden="true">→</span> {successor.key}</h3>
      <span className="gantt-findings-kind" data-kind={check.kind}>{FINDING_LABELS[check.kind]}</span>
    </div>
    <p className="gantt-findings-item-titles">{predecessor.title} → {successor.title}</p>
    {isDependencyType(dependency.type) && isDependencyLag(dependency.lagDays) &&
      <p className="gantt-findings-relation">{dependencyLabel(dependency)}</p>}
    {check.kind === 'invalid' ? <p className="gantt-findings-reason">{check.reason}</p> : <dl className="gantt-findings-dates">
      <div>
        <dt>선행 {SCHEDULE_DATE_LABELS[check.predecessorEndpoint]}</dt>
        <dd>{check.predecessorDate ? <time dateTime={check.predecessorDate}>{check.predecessorDate}</time> : '미정'}</dd>
      </div>
      <div>
        <dt>현재 후행 {SCHEDULE_DATE_LABELS[check.successorEndpoint]}</dt>
        <dd>{check.successorDate ? <time dateTime={check.successorDate}>{check.successorDate}</time> : '미정'}</dd>
      </div>
      {check.kind === 'conflict' && <div className="gantt-findings-bound">
        <dt>후행 {SCHEDULE_DATE_LABELS[check.successorEndpoint]} 가능일</dt>
        <dd><time dateTime={check.requiredDate}>{check.requiredDate}</time>부터</dd>
      </div>}
    </dl>}
    <div className="gantt-findings-actions">
      {(check.kind === 'conflict' || (check.kind === 'missing' && !check.predecessorDate)) && <EditDateButton
        issue={predecessor} endpoint={check.predecessorEndpoint} onLocateDate={onLocateDate} disabled={disabled}
      />}
      {(check.kind === 'conflict' || (check.kind === 'missing' && !check.successorDate)) && <EditDateButton
        issue={successor} endpoint={check.successorEndpoint} onLocateDate={onLocateDate} disabled={disabled}
      />}
      <button type="button" className="btn btn-ghost" disabled={disabled} aria-label={`${predecessor.key} → ${successor.key} 연결 수정`}
        onClick={event => onEditLink(dependency, event.currentTarget)}>
        <Link2 size={14} aria-hidden="true" />연결 수정
      </button>
    </div>
  </>;
}

function EditDateButton({ issue, endpoint, onLocateDate, disabled }: {
  issue: Issue;
  endpoint: ScheduleDependencyEndpoint;
} & Pick<GanttDependencyFindingsProps, 'onLocateDate' | 'disabled'>) {
  return <button type="button" className="btn btn-ghost" disabled={disabled} onClick={() => onLocateDate(issue.id, endpoint)}>
    <CalendarDays size={14} aria-hidden="true" />{`${issue.key} ${SCHEDULE_DATE_LABELS[endpoint]} 수정`}
  </button>;
}
