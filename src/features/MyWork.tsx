'use client';

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowRightLeft, ChevronRight } from 'lucide-react';
import { buildMyWorkQueue, type MyWorkGrouping, type MyWorkGroupId, type MyWorkItem, type MyWorkRole, type MyWorkRoleFilter } from '../../shared/my-work';
import type { FeatureProps, Issue, WorkflowStatus } from '../../shared/types';
import { allowedNextStatuses, projectWorkflow, STATUS_CATEGORY_LABELS } from '../../shared/workflow-helpers';
import type { OpenIssueForReview } from '../lib/issue-review';
import { IssueStatusDialog, type IssueStatusEdit } from './IssueStatusDialog';
import { todayDate } from './schedule-utils';
import './my-work.css';

const groupLabels: Record<MyWorkGroupId, string> = {
  ...STATUS_CATEGORY_LABELS,
  overdue: '마감 초과',
  today: '오늘 마감',
  'next-seven-days': '7일 이내',
  later: '이후',
  undated: '기한 없음',
  closed: '완료·취소',
};
const pageSize = 20;
const roleLabels: Record<MyWorkRole, string> = { assigned: '담당', collaborating: '협력', reported: '요청', subscribed: '구독' };
type StatusSelection = IssueStatusEdit & { opener: HTMLButtonElement };

export function MyWork({ data, actorId, openIssue, notify, refresh, onOpenIssueForReview, subscriptions }: Pick<FeatureProps, 'data' | 'actorId' | 'openIssue' | 'notify' | 'refresh'> & {
  onOpenIssueForReview?: OpenIssueForReview;
  subscriptions: { ids: ReadonlySet<string>; ready: boolean; failed: boolean; reload: () => void };
}) {
  const [today, setToday] = useState(todayDate);
  const [projectId, setProjectId] = useState('');
  const [role, setRole] = useState<MyWorkRoleFilter>('all');
  const [grouping, setGrouping] = useState<MyWorkGrouping>('deadline');
  const [includeClosed, setIncludeClosed] = useState(false);
  const [statusEdit, setStatusEdit] = useState<StatusSelection | null>(null);
  const statusFocus = useRef<StatusSelection | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const queue = useRef<HTMLDivElement>(null);
  const selectedProject = data.projects.some(project => project.id === projectId) ? projectId : '';

  useEffect(() => {
    let timer: number;
    const scheduleMidnight = () => {
      const midnight = new Date();
      midnight.setHours(24, 0, 0, 0);
      timer = window.setTimeout(syncDate, Math.max(0, midnight.getTime() - Date.now()));
    };
    const syncDate = () => {
      window.clearTimeout(timer);
      setToday(todayDate());
      scheduleMidnight();
    };
    syncDate();
    window.addEventListener('focus', syncDate);
    document.addEventListener('visibilitychange', syncDate);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', syncDate);
      document.removeEventListener('visibilitychange', syncDate);
    };
  }, []);

  useLayoutEffect(() => {
    const selection = statusFocus.current;
    if (statusEdit || !selection) return;
    const frame = window.requestAnimationFrame(() => {
      statusFocus.current = null;
      const id = CSS.escape(selection.issue.id);
      const action = queue.current?.querySelector<HTMLButtonElement>(`[data-my-work-status-id="${id}"]`);
      const details = queue.current?.querySelector<HTMLButtonElement>(`[data-issue-review-id="${id}"]`);
      const target = [selection.opener, action, details, heading.current].find(control =>
        control?.isConnected && !control.closest('[inert]') && !control.matches(':disabled'));
      target?.focus({ preventScroll: target === selection.opener });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [statusEdit]);

  const { groups, total } = useMemo(() => buildMyWorkQueue(data, actorId, today, {
    projectId: selectedProject || null, role, includeClosed, grouping,
  }, subscriptions.ids), [data, actorId, today, selectedProject, role, includeClosed, grouping, subscriptions.ids]);
  const usesSubscriptions = role === 'all' || role === 'subscribed';
  const waitingForSubscriptions = usesSubscriptions && !subscriptions.ready && total === 0;

  function openWorkIssue(id: string, opener: HTMLButtonElement) {
    if (!onOpenIssueForReview) { openIssue(id); return; }
    const rows = queue.current?.querySelectorAll<HTMLButtonElement>('button[data-issue-review-id]');
    if (!rows) return;
    // Each group owns its current page, so read the rows rendered in the queue.
    const issueIds = Array.from(rows, row => row.dataset.issueReviewId!);
    onOpenIssueForReview(id, { issueIds, opener, fallback: heading.current, projectScope: selectedProject || null });
  }

  function statusChoices(issue: Issue) {
    return actorId ? allowedNextStatuses(data, issue).filter(status => status.id !== issue.status) : [];
  }

  function openStatusEdit({ issue, status }: MyWorkItem, choices: WorkflowStatus[], opener: HTMLButtonElement) {
    if (statusEdit || !choices.length || !window.dispatchEvent(new Event('teamspace:navigate', { cancelable: true }))) return;
    setStatusEdit({ issue, current: status, choices, workflowVersion: projectWorkflow(data, issue.projectId).version, opener });
  }

  function closeStatusEdit() {
    if (!statusEdit) return;
    statusFocus.current = statusEdit;
    setStatusEdit(null);
  }

  function openStatusDetails(id: string) {
    const opener = queue.current?.querySelector<HTMLButtonElement>(`[data-issue-review-id="${CSS.escape(id)}"]`);
    if (opener) openWorkIssue(id, opener);
    else openIssue(id);
  }

  return (
    <div className="page my-work-page">
      <header className="page-heading my-work-heading">
        <h1 ref={heading} tabIndex={-1}>내 업무</h1>
        <p>기준일 <time dateTime={today}>{today}</time></p>
      </header>

      <div className="card my-work-filters">
        <label className="my-work-filter">
          프로젝트
          <select className="field" value={selectedProject} onChange={event => setProjectId(event.target.value)}>
            <option value="">전체 프로젝트</option>
            {data.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        <label className="my-work-filter">
          참여 범위
          <select className="field" value={role} onChange={event => setRole(event.target.value as MyWorkRoleFilter)}>
            <option value="all">전체 참여 업무</option>
            <option value="assigned">담당 업무</option>
            <option value="collaborating">협력 업무</option>
            <option value="reported">내가 요청한 업무</option>
            <option value="subscribed">구독한 업무</option>
          </select>
        </label>
        <label className="my-work-filter">
          묶는 기준
          <select className="field" value={grouping} onChange={event => setGrouping(event.target.value as MyWorkGrouping)}>
            <option value="deadline">마감 기준</option>
            <option value="status">상태 기준</option>
          </select>
        </label>
        <label className="my-work-include-closed">
          <input type="checkbox" checked={includeClosed} onChange={event => setIncludeClosed(event.target.checked)} />
          완료·취소 포함
        </label>
      </div>

      {usesSubscriptions && subscriptions.failed && <div className="my-work-subscriptions" role="status">
        <span>구독 업무를 불러오지 못했습니다.</span>
        <button className="btn" type="button" onClick={subscriptions.reload}>구독 업무 다시 불러오기</button>
      </div>}
      {waitingForSubscriptions && !subscriptions.failed && <p className="my-work-total" role="status">구독 업무를 불러오는 중입니다.</p>}
      {!waitingForSubscriptions && <p className="my-work-total" role="status">업무 {total.toLocaleString('ko-KR')}개</p>}
      {!waitingForSubscriptions && total === 0 && <p className="card my-work-empty">표시할 업무가 없습니다.</p>}
      <div className="my-work-groups" ref={queue} key={JSON.stringify([today, selectedProject, role, includeClosed, grouping])}>
        {groups.map(({ id, items }) => items.length > 0 && <WorkGroup key={id} id={id} items={items} openIssue={openWorkIssue}
          statusChoices={statusChoices} openStatusEdit={openStatusEdit} />)}
      </div>
      {statusEdit && <IssueStatusDialog edit={statusEdit} actorId={actorId} latest={data} refresh={refresh} notify={notify}
        onClose={closeStatusEdit} onOpenDetails={() => openStatusDetails(statusEdit.issue.id)} />}
    </div>
  );
}

function WorkGroup({ id, items, openIssue, statusChoices, openStatusEdit }: {
  id: MyWorkGroupId; items: MyWorkItem[]; openIssue: (id: string, opener: HTMLButtonElement) => void;
  statusChoices: (issue: Issue) => WorkflowStatus[];
  openStatusEdit: (item: MyWorkItem, choices: WorkflowStatus[], opener: HTMLButtonElement) => void;
}) {
  const headingId = useId();
  const [pageIndex, setPageIndex] = useState(0);
  const lastPage = Math.ceil(items.length / pageSize) - 1;
  const page = Math.min(pageIndex, lastPage);
  const start = page * pageSize;
  const end = Math.min(start + pageSize, items.length);

  return (
    <section className="card my-work-queue-group" data-group={id} aria-labelledby={headingId}>
      <header className="my-work-group-heading">
        <h2 id={headingId}>{groupLabels[id]}</h2>
        <span>{items.length.toLocaleString('ko-KR')}개</span>
      </header>
      <ul className="my-work-list">
        {items.slice(start, end).map(item => {
          const { issue, project, status, role, reported, subscribed, date } = item;
          const choices = statusChoices(issue);
          return <li key={issue.id}>
            <button className="my-work-row" type="button" data-issue-review-id={issue.id}
              onClick={event => openIssue(issue.id, event.currentTarget)}>
              <span className="my-work-identity">
                <span className="my-work-item-title"><span className="issue-key">{issue.key}</span> <strong>{issue.title}</strong></span>
                <span className="my-work-item-project">{project.name}<span aria-hidden="true">·</span>{roleLabels[role]}
                  {reported && role !== 'reported' && <><span aria-hidden="true">·</span>{roleLabels.reported}</>}
                  {subscribed && role !== 'subscribed' && <><span aria-hidden="true">·</span>{roleLabels.subscribed}</>}
                </span>
              </span>
              <span className="my-work-item-status">
                <span className="status-dot" style={{ backgroundColor: status.color }} aria-hidden="true" />{status.label}
              </span>
              <span className="my-work-item-date">
                {date ? <><span>{date.source === 'dueDate' ? '목표 마감일' : '계획 종료일'}</span> <time dateTime={date.value}>{date.value}</time></> : '기한 없음'}
              </span>
              <ChevronRight className="my-work-row-arrow" size={16} aria-hidden="true" />
            </button>
            {choices.length > 0 && <button className="btn btn-ghost my-work-status-action" type="button" aria-haspopup="dialog"
              aria-label={`${issue.key} 상태 변경`} data-my-work-status-id={issue.id} onClick={event => openStatusEdit(item, choices, event.currentTarget)}>
              <ArrowRightLeft size={15} aria-hidden="true" />상태 변경
            </button>}
          </li>;
        })}
      </ul>
      {lastPage > 0 && (
        <nav className="my-work-pages" aria-label={`${groupLabels[id]} 페이지`}>
          <span aria-live="polite">{start + 1}–{end} / {items.length}</span>
          <button className="btn" type="button" disabled={page === 0} onClick={() => setPageIndex(page - 1)}>이전</button>
          <button className="btn" type="button" disabled={page === lastPage} onClick={() => setPageIndex(page + 1)}>다음</button>
        </nav>
      )}
    </section>
  );
}
