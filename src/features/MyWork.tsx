'use client';

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowRightLeft, ChevronRight, ListChecks } from 'lucide-react';
import { buildMyWorkQueue, type MyWorkGrouping, type MyWorkGroupId, type MyWorkItem, type MyWorkRole, type MyWorkRoleFilter } from '../../shared/my-work';
import { ISSUE_BULK_EDIT_LIMIT, type FeatureProps, type Issue, type WorkflowStatus } from '../../shared/types';
import { allowedNextStatuses, projectWorkflow, STATUS_CATEGORY_LABELS } from '../../shared/workflow-helpers';
import type { OpenIssueForReview } from '../lib/issue-review';
import { IssueBulkEdit, IssueBulkSelectVisible, useIssueBulkEdit } from './IssueBulkEdit';
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
type GroupPages = Partial<Record<MyWorkGroupId, number>>;

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
  const [pagination, setPagination] = useState<{ scope: string; pages: GroupPages }>({ scope: '', pages: {} });
  const statusFocus = useRef<StatusSelection | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const queue = useRef<HTMLDivElement>(null);
  const bulkToggle = useRef<HTMLButtonElement>(null);
  const bulkControls = useRef<HTMLDivElement>(null);
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
  const queueScope = JSON.stringify([today, selectedProject, role, includeClosed, grouping]);
  const pages = pagination.scope === queueScope ? pagination.pages : {};
  if (pagination.scope !== queueScope) setPagination({ scope: queueScope, pages });
  const visibleGroups = groups.filter(group => group.items.length > 0).map(({ id, items }) => {
    const lastPage = Math.ceil(items.length / pageSize) - 1;
    const page = Math.min(pages[id] ?? 0, lastPage);
    return { id, size: items.length, lastPage, page, items: items.slice(page * pageSize, (page + 1) * pageSize) };
  });
  const visibleIssues = visibleGroups.flatMap(group => group.items.map(item => item.issue));
  const bulk = useIssueBulkEdit({ data, projectId: selectedProject, actorId, refresh, notify }, visibleIssues, undefined, { team: true });
  const usesSubscriptions = role === 'all' || role === 'subscribed';
  const waitingForSubscriptions = usesSubscriptions && !subscriptions.ready && total === 0;

  function openWorkIssue(id: string, opener: HTMLButtonElement) {
    if (!onOpenIssueForReview) { openIssue(id); return; }
    onOpenIssueForReview(id, { issueIds: visibleIssues.map(issue => issue.id), opener, fallback: heading.current, projectScope: selectedProject || null });
  }

  function closeBulkEdit() {
    if (bulk.close()) (visibleIssues.length ? bulkToggle.current : heading.current)?.focus({ preventScroll: true });
  }

  function toggleBulkEdit() {
    if (bulk.active) { closeBulkEdit(); return; }
    bulk.open();
    requestAnimationFrame(() => {
      const first = bulkControls.current?.querySelector<HTMLInputElement>('input:not(:disabled)');
      (first ?? bulkControls.current)?.focus({ preventScroll: true });
    });
  }

  function statusChoices(issue: Issue) {
    return actorId ? allowedNextStatuses(data, issue).filter(status => status.id !== issue.status) : [];
  }

  function openStatusEdit({ issue, status }: MyWorkItem, choices: WorkflowStatus[], opener: HTMLButtonElement) {
    if (statusEdit || bulk.active || !choices.length || !window.dispatchEvent(new Event('teamspace:navigate', { cancelable: true }))) return;
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
        <div className="my-work-heading-actions">
          <p>기준일 <time dateTime={today}>{today}</time></p>
          <button ref={bulkToggle} type="button" className="btn issue-bulk-toggle" aria-pressed={bulk.active}
            disabled={bulk.busy || Boolean(statusEdit) || (!bulk.active && !visibleIssues.length)} onClick={toggleBulkEdit}>
            <ListChecks size={16} aria-hidden="true" />내 업무 일괄 편집
          </button>
        </div>
      </header>

      <div className="card my-work-filters">
        <label className="my-work-filter">
          프로젝트
          <select className="field" value={selectedProject} disabled={bulk.locked} onChange={event => setProjectId(event.target.value)}>
            <option value="">전체 프로젝트</option>
            {data.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        <label className="my-work-filter">
          참여 범위
          <select className="field" value={role} disabled={bulk.locked} onChange={event => setRole(event.target.value as MyWorkRoleFilter)}>
            <option value="all">전체 참여 업무</option>
            <option value="assigned">담당 업무</option>
            <option value="collaborating">협력 업무</option>
            <option value="reported">내가 요청한 업무</option>
            <option value="subscribed">구독한 업무</option>
          </select>
        </label>
        <label className="my-work-filter">
          묶는 기준
          <select className="field" value={grouping} disabled={bulk.locked} onChange={event => setGrouping(event.target.value as MyWorkGrouping)}>
            <option value="deadline">마감 기준</option>
            <option value="status">상태 기준</option>
          </select>
        </label>
        <label className="my-work-include-closed">
          <input type="checkbox" checked={includeClosed} disabled={bulk.locked} onChange={event => setIncludeClosed(event.target.checked)} />
          완료·취소 포함
        </label>
      </div>

      {usesSubscriptions && subscriptions.failed && <div className="my-work-subscriptions" role="status">
        <span>구독 업무를 불러오지 못했습니다.</span>
        <button className="btn" type="button" disabled={bulk.locked} onClick={subscriptions.reload}>구독 업무 다시 불러오기</button>
      </div>}
      {waitingForSubscriptions && !subscriptions.failed && <p className="my-work-total" role="status">구독 업무를 불러오는 중입니다.</p>}
      {!waitingForSubscriptions && <p className="my-work-total" role="status">업무 {total.toLocaleString('ko-KR')}개</p>}
      {bulk.active && <>
        <div className="my-work-bulk-controls" ref={bulkControls} tabIndex={-1}>
          <IssueBulkSelectVisible editor={bulk} label="표시된 업무 전체 선택" />
        </div>
        <IssueBulkEdit editor={bulk} statuses={[]} users={data.users} onClose={closeBulkEdit}
          selectionNote="각 그룹에서 현재 페이지에 표시된 업무를 선택할 수 있습니다." />
      </>}
      {!waitingForSubscriptions && total === 0 && <p className="card my-work-empty">표시할 업무가 없습니다.</p>}
      <div className="my-work-groups" ref={queue} key={queueScope}>
        {visibleGroups.map(group => <WorkGroup key={group.id} {...group} openIssue={openWorkIssue}
          setPage={page => setPagination(current => ({ ...current, pages: { ...current.pages, [group.id]: page } }))}
          statusChoices={statusChoices} openStatusEdit={openStatusEdit} bulk={bulk} />)}
      </div>
      {statusEdit && <IssueStatusDialog edit={statusEdit} actorId={actorId} latest={data} refresh={refresh} notify={notify}
        onClose={closeStatusEdit} onOpenDetails={() => openStatusDetails(statusEdit.issue.id)} />}
    </div>
  );
}

function WorkGroup({ id, items, size, page, lastPage, setPage, openIssue, statusChoices, openStatusEdit, bulk }: {
  id: MyWorkGroupId; items: MyWorkItem[]; size: number; page: number; lastPage: number;
  setPage: (page: number) => void; openIssue: (id: string, opener: HTMLButtonElement) => void;
  statusChoices: (issue: Issue) => WorkflowStatus[];
  openStatusEdit: (item: MyWorkItem, choices: WorkflowStatus[], opener: HTMLButtonElement) => void;
  bulk: Pick<ReturnType<typeof useIssueBulkEdit>, 'active' | 'locked' | 'selectedIds' | 'selectedCount' | 'toggle'>;
}) {
  const headingId = useId();
  const start = page * pageSize;

  return (
    <section className="card my-work-queue-group" data-group={id} aria-labelledby={headingId}>
      <header className="my-work-group-heading">
        <h2 id={headingId}>{groupLabels[id]}</h2>
        <span>{size.toLocaleString('ko-KR')}개</span>
      </header>
      <ul className="my-work-list">
        {items.map(item => {
          const { issue, project, status, role, reported, subscribed, date } = item;
          const choices = bulk.active ? [] : statusChoices(issue);
          const selected = bulk.active && bulk.selectedIds.has(issue.id);
          return <li key={issue.id} data-bulk-selected={selected || undefined}>
            <button className="my-work-row" type="button" data-issue-review-id={issue.id} disabled={bulk.locked}
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
            {bulk.active ? <label className="my-work-bulk-row-select">
              <input type="checkbox" aria-label={`${issue.key} 업무 선택`} checked={selected}
                disabled={bulk.locked || (!selected && bulk.selectedCount >= ISSUE_BULK_EDIT_LIMIT)} onChange={() => bulk.toggle(issue)} />
            </label> : choices.length > 0 && <button className="btn btn-ghost my-work-status-action" type="button" aria-haspopup="dialog"
              aria-label={`${issue.key} 상태 변경`} data-my-work-status-id={issue.id} onClick={event => openStatusEdit(item, choices, event.currentTarget)}>
              <ArrowRightLeft size={15} aria-hidden="true" />상태 변경
            </button>}
          </li>;
        })}
      </ul>
      {lastPage > 0 && (
        <nav className="my-work-pages" aria-label={`${groupLabels[id]} 페이지`}>
          <span aria-live="polite">{start + 1}–{start + items.length} / {size}</span>
          <button className="btn" type="button" disabled={bulk.locked || page === 0} onClick={() => setPage(page - 1)}>이전</button>
          <button className="btn" type="button" disabled={bulk.locked || page === lastPage} onClick={() => setPage(page + 1)}>다음</button>
        </nav>
      )}
    </section>
  );
}
