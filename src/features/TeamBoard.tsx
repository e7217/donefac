'use client';

import { ArrowRightLeft, Link2, RefreshCw, Search } from 'lucide-react';
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { isIssueViewGitlabFilter, STATUS, type FeatureProps, type Issue, type StatusCategory, type TeamBoardFilters, type WorkflowStatus, type WorkspaceSnapshot } from '../../shared/types';
import { issueSearchText } from '../../shared/issue-schema';
import { summarizeIssueGitlabLinks } from '../../shared/issue-gitlab-view';
import { matchesGitlabFilter, orderProjectIssues } from '../../shared/issue-view';
import { allowedNextStatuses, projectWorkflow, statusMeta, STATUS_CATEGORY_LABELS } from '../../shared/workflow-helpers';
import { dateLabel } from '../lib/api';
import type { OpenIssueForReview } from '../lib/issue-review';
import { useWorkspaceRefresh, type WorkspaceRefresh } from '../lib/workspace-refresh';
import { IssueTypeIcon, StatusDot } from './Issues';
import { ISSUE_GITLAB_FILTER_LABELS, IssueGitlabSummary } from './IssueGitlabSummary';
import { IssueStatusDialog, type IssueStatusEdit } from './IssueStatusDialog';
import './team-board.css';

type Props = FeatureProps & {
  filters: TeamBoardFilters;
  onFiltersChange: (filters: TeamBoardFilters) => void;
  onOpenBoardIssue: (id: string, trigger: { opener: HTMLElement; fallback: HTMLElement | null }) => void;
  onOpenIssueForReview?: OpenIssueForReview;
  refreshBoard: WorkspaceRefresh;
  issueOverlayOpen: boolean;
};
type StatusEdit = IssueStatusEdit & { opener: HTMLElement };
type BoardEntry = { issue: Issue; status: WorkflowStatus; projectKey: string; projectName: string };

const CATEGORIES = Object.keys(STATUS_CATEGORY_LABELS) as StatusCategory[];
const DRAG_TYPE = 'application/x-teamspace-team-board-issue';
const HEADING = '전체 프로젝트 보드';
const refreshMessages = {
  updated: '팀 보드를 새로고침했습니다.',
  skipped: '팀 보드 새로고침을 건너뛰었습니다.',
  failed: '팀 보드를 새로고침하지 못했습니다. 다시 시도해 주세요.',
} as const;

function destinations(data: WorkspaceSnapshot, issue: Issue, category?: StatusCategory) {
  return allowedNextStatuses(data, issue).filter(status => status.id !== issue.status && (category === undefined || status.category === category));
}

export default function TeamBoard({ data, filters, onFiltersChange, onOpenBoardIssue, onOpenIssueForReview, refresh, notify, refreshBoard, issueOverlayOpen }: Props) {
  const heading = useId();
  const board = useRef<HTMLDivElement>(null);
  const focusedCard = useRef<{ control: HTMLElement; issueId: string; selector: string } | null>(null);
  const drag = useRef<{ entry: BoardEntry; opener: HTMLElement } | null>(null);
  const chooserOpen = useRef(false);
  const [dropTarget, setDropTarget] = useState<StatusCategory | null>(null);
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState<StatusEdit | null>(null);
  const [copyFallback, setCopyFallback] = useState<{ filterKey: string; url: string } | null>(null);
  const filterKey = JSON.stringify([filters.projectId, filters.memberId === null, filters.memberId, filters.query, filters.gitlab]);
  const refreshPaused = issueOverlayOpen || Boolean(editing) || dragging;
  const hasLocalInteraction = useCallback(() => Boolean(chooserOpen.current || drag.current), []);
  const { requestMode, feedback, manualRefresh } = useWorkspaceRefresh(refreshBoard, refreshPaused, hasLocalInteraction);
  useLayoutEffect(() => {
    const focused = focusedCard.current;
    if (!focused || focused.control.isConnected || refreshPaused || document.activeElement !== document.body) return;
    const card = board.current?.querySelector(`[data-issue-id="${CSS.escape(focused.issueId)}"]`);
    const control = card?.querySelector<HTMLButtonElement>(focused.selector);
    const open = card?.querySelector<HTMLButtonElement>('[data-team-board-open-action]');
    const target = control && !control.disabled ? control : open ?? board.current;
    focusedCard.current = null;
    target?.focus({ preventScroll: true });
    if (target && target !== board.current) target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [data, filterKey, refreshPaused]);
  const shareUrl = copyFallback?.filterKey === filterKey ? copyFallback.url : null;
  const members = useMemo(() => new Map(data.users.map(user => [user.id, user])), [data.users]);
  const links = useMemo(() => summarizeIssueGitlabLinks(data.gitlabLinks), [data.gitlabLinks]);
  const { columns, visible } = useMemo(() => {
    const groups = new Map<StatusCategory, BoardEntry[]>(CATEGORIES.map(category => [category, []]));
    const scoped = new Map<string, Issue[]>();
    for (const issue of data.issues) {
      if (filters.projectId && issue.projectId !== filters.projectId || filters.memberId !== undefined && issue.assigneeId !== filters.memberId) continue;
      if (filters.gitlab && !matchesGitlabFilter(filters.gitlab, links.get(issue.id))) continue;
      const projectIssues = scoped.get(issue.projectId);
      if (projectIssues) projectIssues.push(issue);
      else scoped.set(issue.projectId, [issue]);
    }
    const orders = new Map(data.issueOrders?.map(order => [order.projectId, order]));
    const query = (filters.query ?? '').trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    let visible = 0;
    for (const project of data.projects) {
      const projectIssues = scoped.get(project.id);
      if (!projectIssues?.length) continue;
      const statuses = new Map(projectWorkflow(data, project.id).statuses.map(status => [status.id, status]));
      for (const issue of orderProjectIssues(projectIssues, orders.get(project.id))) {
        const status = statuses.get(issue.status) ?? statusMeta(data, project.id, issue.status);
        if (query.length) {
          const text = `${project.key} ${project.name} ${status.label} ${issueSearchText(data, issue)}`.toLocaleLowerCase();
          if (!query.every(term => text.includes(term))) continue;
        }
        groups.get(status.category)?.push({ issue, status, projectKey: project.key, projectName: project.name });
        visible++;
      }
    }
    return { columns: groups, visible };
  }, [data, filters.projectId, filters.memberId, filters.query, filters.gitlab, links]);

  function openStatus(entry: BoardEntry, opener: HTMLElement, category?: StatusCategory) {
    const choices = destinations(data, entry.issue, category);
    if (!choices.length || editing) return;
    chooserOpen.current = true;
    setEditing({ issue: entry.issue, current: entry.status, choices, workflowVersion: projectWorkflow(data, entry.issue.projectId).version, opener });
  }

  function closeStatus() {
    if (!editing) return;
    const { issue, opener } = editing;
    chooserOpen.current = false;
    setEditing(null);
    requestAnimationFrame(() => {
      const card = board.current?.querySelector(`[data-issue-id="${CSS.escape(issue.id)}"]`);
      const action = card?.querySelector<HTMLButtonElement>('[data-team-board-status-action]');
      const details = card?.querySelector<HTMLButtonElement>('[data-team-board-open-action]');
      const target = [opener, action, details, board.current].find(control =>
        control?.isConnected && !control.closest('[inert]') && !control.matches(':disabled'));
      target?.focus({ preventScroll: true });
      if (target && target !== opener && target !== board.current) target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }

  function openEditedIssue() {
    if (!editing) return;
    const opener = board.current?.querySelector<HTMLButtonElement>(`[data-issue-id="${CSS.escape(editing.issue.id)}"] [data-team-board-open-action]`);
    onOpenBoardIssue(editing.issue.id, { opener: opener ?? editing.opener, fallback: board.current });
  }

  function openCardIssue(id: string, opener: HTMLElement) {
    const fallback = board.current;
    if (!onOpenIssueForReview) { onOpenBoardIssue(id, { opener, fallback }); return; }
    const issueIds = CATEGORIES.flatMap(category => (columns.get(category) ?? []).map(({ issue }) => issue.id));
    onOpenIssueForReview(id, { issueIds, opener, fallback });
  }

  function startDrag(event: DragEvent<HTMLElement>, entry: BoardEntry) {
    if (editing || !destinations(data, entry.issue).some(status => status.category !== entry.status.category)) {
      event.preventDefault();
      return;
    }
    const opener = event.currentTarget.querySelector<HTMLButtonElement>('[data-team-board-status-action]') ?? event.currentTarget;
    drag.current = { entry, opener };
    setDragging(true);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(DRAG_TYPE, entry.issue.id);
  }

  function endDrag() {
    drag.current = null;
    setDragging(false);
    setDropTarget(null);
  }

  function canDrop(event: DragEvent<HTMLElement>, category: StatusCategory) {
    const source = drag.current;
    return source && !editing && event.dataTransfer.types.includes(DRAG_TYPE) && source.entry.status.category !== category &&
      destinations(data, source.entry.issue, category).length > 0;
  }

  function drop(event: DragEvent<HTMLElement>, category: StatusCategory) {
    const source = drag.current;
    const valid = canDrop(event, category);
    endDrag();
    if (!valid || !source || event.dataTransfer.getData(DRAG_TYPE) !== source.entry.issue.id) return;
    event.preventDefault();
    openStatus(source.entry, source.opener, category);
  }

  async function copyLink() {
    const url = new URL(window.location.href);
    const [path, query = ''] = url.hash.split('?');
    const params = new URLSearchParams(query);
    params.delete('issue');
    params.delete('documentPreview');
    url.hash = `${path}${params.size ? `?${params}` : ''}`;
    setCopyFallback(null);
    try { await navigator.clipboard.writeText(url.href); notify('보드 링크를 복사했습니다.'); }
    catch { setCopyFallback({ filterKey, url: url.href }); }
  }

  return <div className="team-board-page">
    <header className="feature-heading team-board-heading">
      <h1 id={heading}>{HEADING}</h1>
      <div className="team-board-heading-actions">
        <button type="button" className="btn" aria-disabled={refreshPaused || requestMode !== null} aria-busy={requestMode === 'manual'} onClick={manualRefresh}>
          <RefreshCw size={16} className={requestMode === 'manual' ? 'spin' : undefined} aria-hidden="true" />팀 보드 새로고침
        </button>
        <button type="button" className="btn" onClick={() => void copyLink()}><Link2 size={16} aria-hidden="true" />보드 링크 복사</button>
      </div>
    </header>
    <div className="team-board-filters">
      <label>프로젝트
        <select className="field" aria-label="프로젝트 필터" value={filters.projectId ?? ''}
          onChange={event => onFiltersChange({ ...filters, projectId: event.currentTarget.value || undefined })}>
          <option value="">전체 프로젝트</option>
          {data.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </label>
      <label>담당자
        <select className="field" aria-label="담당자 필터" value={filters.memberId === null ? 'unassigned' : filters.memberId === undefined ? '' : `member:${filters.memberId}`}
          onChange={event => {
            const value = event.currentTarget.value;
            onFiltersChange({ ...filters, memberId: value === 'unassigned' ? null : value ? value.slice('member:'.length) : undefined });
          }}>
          <option value="">전체 담당자</option>
          <option value="unassigned">미지정</option>
          {data.users.map(user => <option key={user.id} value={`member:${user.id}`}>{user.name}</option>)}
        </select>
      </label>
      <label className="team-board-gitlab">GitLab 조건
        <select className="field" aria-label="GitLab 조건" value={filters.gitlab ?? ''}
          onChange={event => {
            const value = event.currentTarget.value;
            onFiltersChange({ ...filters, gitlab: isIssueViewGitlabFilter(value) ? value : undefined });
          }}>
          <option value="">GitLab 전체</option>
          {Object.entries(ISSUE_GITLAB_FILTER_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label className="team-board-query">업무 검색
        <span><Search size={15} aria-hidden="true" />
          <input className="field" type="search" value={filters.query ?? ''} maxLength={200} aria-label="보드 업무 검색"
            onChange={event => onFiltersChange({ ...filters, query: event.currentTarget.value || undefined })} />
        </span>
      </label>
    </div>
    {shareUrl && <label className="team-board-share-fallback">보드 공유 링크
      <input className="field" readOnly value={shareUrl} onFocus={event => event.currentTarget.select()} />
    </label>}
    {feedback && <p className={`team-board-refresh-feedback${feedback === 'failed' ? ' issue-form-error' : ''}`}
      role={feedback === 'failed' ? 'alert' : 'status'}>{refreshMessages[feedback]}</p>}
    <p className="team-board-count" role="status">표시된 업무 {visible.toLocaleString('ko-KR')}개</p>
    <div ref={board} className="team-board-columns" role="region" aria-labelledby={heading} tabIndex={0}
      onFocusCapture={event => {
        const control = event.target;
        const issueId = control.closest<HTMLElement>('[data-issue-id]')?.dataset.issueId;
        focusedCard.current = issueId ? { control, issueId, selector: control.hasAttribute('data-team-board-status-action')
          ? '[data-team-board-status-action]' : '[data-team-board-open-action]' } : null;
      }} onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget) && (event.relatedTarget || event.target.isConnected)) focusedCard.current = null;
      }}>
      {CATEGORIES.map(category => {
        const entries = columns.get(category) ?? [];
        return <section key={category} className="team-board-column" aria-label={STATUS_CATEGORY_LABELS[category]}
          data-status-category={category} data-drop-target={dropTarget === category ? '' : undefined}
          onDragOver={event => { if (canDrop(event, category)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget(category); } }}
          onDragLeave={event => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setDropTarget(value => value === category ? null : value); }}
          onDrop={event => drop(event, category)}>
          <header><StatusDot color={STATUS[category].color} /><h2>{STATUS_CATEGORY_LABELS[category]}</h2><span>{entries.length}</span></header>
          {entries.length ? <ul role="list">
            {entries.map(entry => {
              const { issue, status, projectKey, projectName } = entry;
              const owner = issue.assigneeId ? members.get(issue.assigneeId) : undefined;
              const choices = destinations(data, issue);
              const dateText = issue.dueDate ? `마감 ${dateLabel(issue.dueDate)}` : issue.endDate ? `종료 ${dateLabel(issue.endDate)}` : '';
              return <li key={issue.id} className="team-board-card" data-issue-id={issue.id}
                draggable={choices.some(choice => choice.category !== status.category)} onDragStart={event => startDrag(event, entry)} onDragEnd={endDrag}>
                <button type="button" className="team-board-card-open" aria-label={`${issue.key} 업무 열기`} data-team-board-open-action=""
                  onClick={event => openCardIssue(issue.id, event.currentTarget)}>
                  <span className="team-board-key"><IssueTypeIcon type={issue.type} data={data} projectId={issue.projectId} />{issue.key}</span>
                  <strong>{issue.title}</strong>
                  <span className="team-board-card-labels">
                    <span data-board-project={issue.projectId}>{projectKey} · {projectName}</span>
                    <span data-board-status={status.id}><StatusDot color={status.color} />{status.label}</span>
                  </span>
                </button>
                <IssueGitlabSummary summary={links.get(issue.id)} />
                <div className="team-board-card-footer">
                  <span>{owner?.name ?? '미지정'}{dateText && ` · ${dateText}`}</span>
                  <button type="button" className="btn btn-ghost" aria-label={`${issue.key} 상태 변경`} data-team-board-status-action=""
                    disabled={!choices.length} onClick={event => openStatus(entry, event.currentTarget)}><ArrowRightLeft size={15} aria-hidden="true" />상태 변경</button>
                </div>
              </li>;
            })}
          </ul> : <p className="team-board-empty">업무 없음</p>}
        </section>;
      })}
    </div>
    {editing && <IssueStatusDialog edit={editing} latest={data} refresh={refresh} notify={notify} onClose={closeStatus} onOpenDetails={openEditedIssue} />}
  </div>;
}
