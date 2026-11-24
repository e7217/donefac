'use client';

import { useId, useMemo, useState, type PointerEvent } from 'react';
import { ArrowLeft, ArrowRight, CalendarDays, Link2, TriangleAlert, X } from 'lucide-react';
import {
  isDependencyLag, isDependencyType, SCHEDULE_DATE_LABELS,
  type DependencyScheduleCheck, type ScheduleDependencyEndpoint, type TeamBlockerScheduleCheck,
} from '../../shared/schedule-dependencies';
import type { Dependency, Issue, TeamScheduleBlocker } from '../../shared/types';
import { dependencyLabel } from './schedule-utils';
import './gantt-dependency-findings.css';

export interface GanttDependencyFinding {
  dependency: Dependency;
  predecessor: Issue;
  successor: Issue;
  check: Exclude<DependencyScheduleCheck, { kind: 'valid' }>;
}

export interface GanttTeamBlockerFinding {
  relation: TeamScheduleBlocker;
  predecessor: Issue;
  successor: Issue;
  check: Exclude<TeamBlockerScheduleCheck, { kind: 'valid' }>;
}

type GanttScheduleFinding = GanttDependencyFinding | GanttTeamBlockerFinding;

interface GanttDependencyFindingsProps {
  id: string;
  findings: readonly GanttScheduleFinding[];
  onClose: () => void;
  onLocateDate: (issueId: string, endpoint: ScheduleDependencyEndpoint) => void;
  onEditLink: (dependency: Dependency, opener: HTMLButtonElement) => void;
  onReviewTeamBlocker: (finding: GanttTeamBlockerFinding, opener: HTMLButtonElement) => void;
  onPointerDown?: (event: PointerEvent<HTMLButtonElement>) => void;
  disabled: boolean;
  focused?: boolean;
  allProjects?: boolean;
}

const PAGE_SIZE = 8;
const FINDING_LABELS = { conflict: '충돌', missing: '날짜 미정', invalid: '확인 필요' } as const;
const FINDING_KINDS = ['conflict', 'missing', 'invalid'] as const;

export function GanttDependencyFindings({
  id, findings, onClose, onLocateDate, onEditLink, onReviewTeamBlocker, onPointerDown, disabled, focused, allProjects,
}: GanttDependencyFindingsProps) {
  const heading = useId();
  const [page, setPage] = useState(0);
  const { counts, ordered } = useMemo(() => {
    const groups: Record<GanttScheduleFinding['check']['kind'], GanttScheduleFinding[]> = {
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
        <p>{focused ? '현재 업무 흐름에 연결된 선후행 일정과 프로젝트 간 차단을 점검합니다.' : allProjects
          ? '프로젝트별 선후행 일정과 프로젝트 간 차단을 점검합니다.'
          : '이 프로젝트의 선후행 일정과 다른 프로젝트와의 차단을 점검합니다.'}</p>
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
        {ordered.slice(offset, offset + PAGE_SIZE).map(finding => {
          const relationId = 'relation' in finding ? finding.relation.id : undefined;
          const key = 'relation' in finding ? `blocker:${finding.relation.id}` : `dependency:${finding.dependency.id}`;
          return <li key={key} data-team-blocker-id={relationId}>
            <FindingDetails finding={finding} onLocateDate={onLocateDate} onEditLink={onEditLink}
              onReviewTeamBlocker={onReviewTeamBlocker} onPointerDown={onPointerDown} disabled={disabled} />
          </li>;
        })}
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

function FindingDetails({ finding, onLocateDate, onEditLink, onReviewTeamBlocker, onPointerDown, disabled }: {
  finding: GanttScheduleFinding;
} & Pick<GanttDependencyFindingsProps, 'onLocateDate' | 'onEditLink' | 'onReviewTeamBlocker' | 'onPointerDown' | 'disabled'>) {
  const heading = useId();
  const { predecessor, successor, check } = finding;
  const teamBlocker = 'relation' in finding ? finding : undefined;
  const dependency = 'dependency' in finding ? finding.dependency : undefined;
  const requiredDate = check.kind === 'conflict' ? check.requiredDate
    : teamBlocker?.check.kind === 'missing' ? teamBlocker.check.requiredDate : undefined;
  return <>
    <div className="gantt-findings-item-heading">
      <h3 id={heading}>{predecessor.key} <span aria-hidden="true">→</span> {successor.key}</h3>
      <span className="gantt-findings-kind" data-kind={check.kind}>{FINDING_LABELS[check.kind]}</span>
    </div>
    <p className="gantt-findings-item-titles">{predecessor.title} → {successor.title}</p>
    {teamBlocker && <p className="gantt-findings-relation gantt-findings-team-relation">
      프로젝트 간 차단 · {teamBlocker.relation.origin === 'jira' ? 'Jira 원본' : 'Teamspace'}
    </p>}
    {dependency && isDependencyType(dependency.type) && isDependencyLag(dependency.lagDays) &&
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
      {requiredDate && <div className="gantt-findings-bound">
        <dt>후행 {SCHEDULE_DATE_LABELS[check.successorEndpoint]} 가능일</dt>
        <dd><time dateTime={requiredDate}>{requiredDate}</time>부터</dd>
      </div>}
    </dl>}
    <div className="gantt-findings-actions">
      {(check.kind === 'conflict' || (check.kind === 'missing' && !check.predecessorDate)) && <EditDateButton
        issue={predecessor} endpoint={check.predecessorEndpoint} onLocateDate={onLocateDate} onPointerDown={onPointerDown} disabled={disabled}
      />}
      {(check.kind === 'conflict' || (check.kind === 'missing' && !check.successorDate)) && <EditDateButton
        issue={successor} endpoint={check.successorEndpoint} onLocateDate={onLocateDate} onPointerDown={onPointerDown} disabled={disabled}
      />}
      {dependency && <button type="button" className="btn btn-ghost" disabled={disabled} aria-label={`${predecessor.key} → ${successor.key} 연결 수정`}
        onClick={event => onEditLink(dependency, event.currentTarget)}>
        <Link2 size={14} aria-hidden="true" />연결 수정
      </button>}
      {teamBlocker && check.kind === 'conflict' && <button type="button" className="btn" aria-haspopup="dialog" aria-describedby={heading}
        data-gantt-focus-control="" onPointerDown={onPointerDown} disabled={disabled}
        onClick={event => onReviewTeamBlocker(teamBlocker, event.currentTarget)}>
        <CalendarDays size={14} aria-hidden="true" />프로젝트 간 일정 검토
      </button>}
    </div>
  </>;
}

function EditDateButton({ issue, endpoint, onLocateDate, onPointerDown, disabled }: {
  issue: Issue;
  endpoint: ScheduleDependencyEndpoint;
} & Pick<GanttDependencyFindingsProps, 'onLocateDate' | 'onPointerDown' | 'disabled'>) {
  return <button type="button" className="btn btn-ghost" data-gantt-focus-control="" onPointerDown={onPointerDown}
    disabled={disabled} onClick={() => onLocateDate(issue.id, endpoint)}>
    <CalendarDays size={14} aria-hidden="true" />{`${issue.key} ${SCHEDULE_DATE_LABELS[endpoint]} 수정`}
  </button>;
}
