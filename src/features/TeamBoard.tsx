'use client';

import { ArrowRightLeft, Link2, Search, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { STATUS, type FeatureProps, type Issue, type StatusCategory, type TeamBoardFilters, type WorkflowStatus, type WorkspaceSnapshot } from '../../shared/types';
import { issueSearchText } from '../../shared/issue-schema';
import { summarizeIssueGitlabLinks } from '../../shared/issue-gitlab-view';
import { orderProjectIssues } from '../../shared/issue-view';
import { allowedNextStatuses, projectWorkflow, statusMeta, STATUS_CATEGORY_LABELS } from '../../shared/workflow-helpers';
import { api, ApiError, dateLabel, patch } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import { IssueTypeIcon, StatusDot } from './Issues';
import { IssueGitlabSummary } from './IssueGitlabSummary';
import { errorMessage } from './schedule-utils';
import './team-board.css';

type Props = FeatureProps & {
  filters: TeamBoardFilters;
  onFiltersChange: (filters: TeamBoardFilters) => void;
  onOpenBoardIssue: (id: string, trigger: { opener: HTMLElement; fallback: HTMLElement | null }) => void;
};
type StatusEdit = { issue: Issue; current: WorkflowStatus; choices: WorkflowStatus[]; workflowVersion: number; opener: HTMLElement };
type BoardEntry = { issue: Issue; status: WorkflowStatus; projectKey: string; projectName: string };
type Recovery = 'conflict' | 'verify' | 'refresh';

const CATEGORIES = Object.keys(STATUS_CATEGORY_LABELS) as StatusCategory[];
const DRAG_TYPE = 'application/x-teamspace-team-board-issue';
const HEADING = '전체 프로젝트 보드';
const STALE = '업무 또는 프로젝트 워크플로가 변경되었습니다. 최신 상태를 불러온 뒤 다시 선택해 주세요.';
const UNKNOWN = '상태 변경 결과를 확인하지 못했습니다. 최신 상태를 확인해 주세요.';
const REFRESH = '상태를 저장했습니다. 보드에 반영하려면 최신 업무를 불러와 주세요.';

function destinations(data: WorkspaceSnapshot, issue: Issue, category?: StatusCategory) {
  return allowedNextStatuses(data, issue).filter(status => status.id !== issue.status && (category === undefined || status.category === category));
}

export default function TeamBoard({ data, filters, onFiltersChange, onOpenBoardIssue, refresh, notify }: Props) {
  const heading = useId();
  const board = useRef<HTMLDivElement>(null);
  const drag = useRef<{ entry: BoardEntry; opener: HTMLElement } | null>(null);
  const [dropTarget, setDropTarget] = useState<StatusCategory | null>(null);
  const [editing, setEditing] = useState<StatusEdit | null>(null);
  const [copyFallback, setCopyFallback] = useState<{ filterKey: string; url: string } | null>(null);
  const filterKey = JSON.stringify([filters.projectId, filters.memberId === null, filters.memberId, filters.query]);
  const shareUrl = copyFallback?.filterKey === filterKey ? copyFallback.url : null;
  const members = useMemo(() => new Map(data.users.map(user => [user.id, user])), [data.users]);
  const links = useMemo(() => summarizeIssueGitlabLinks(data.gitlabLinks), [data.gitlabLinks]);
  const { columns, visible } = useMemo(() => {
    const groups = new Map<StatusCategory, BoardEntry[]>(CATEGORIES.map(category => [category, []]));
    const scoped = new Map<string, Issue[]>();
    for (const issue of data.issues) {
      if (filters.projectId && issue.projectId !== filters.projectId || filters.memberId !== undefined && issue.assigneeId !== filters.memberId) continue;
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
  }, [data, filters.projectId, filters.memberId, filters.query]);

  function openStatus(entry: BoardEntry, opener: HTMLElement, category?: StatusCategory) {
    const choices = destinations(data, entry.issue, category);
    if (!choices.length || editing) return;
    setEditing({ issue: entry.issue, current: entry.status, choices, workflowVersion: projectWorkflow(data, entry.issue.projectId).version, opener });
  }

  function closeStatus() {
    if (!editing) return;
    const { issue, opener } = editing;
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

  function startDrag(event: DragEvent<HTMLElement>, entry: BoardEntry) {
    if (editing || !destinations(data, entry.issue).some(status => status.category !== entry.status.category)) {
      event.preventDefault();
      return;
    }
    const opener = event.currentTarget.querySelector<HTMLButtonElement>('[data-team-board-status-action]') ?? event.currentTarget;
    drag.current = { entry, opener };
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(DRAG_TYPE, entry.issue.id);
  }

  function endDrag() {
    drag.current = null;
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
      <button type="button" className="btn" onClick={() => void copyLink()}><Link2 size={16} aria-hidden="true" />보드 링크 복사</button>
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
    <p className="team-board-count" role="status">표시된 업무 {visible.toLocaleString('ko-KR')}개</p>
    <div ref={board} className="team-board-columns" role="region" aria-labelledby={heading} tabIndex={0}>
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
                  onClick={event => onOpenBoardIssue(issue.id, { opener: event.currentTarget, fallback: board.current })}>
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
    {editing && <StatusDialog edit={editing} latest={data} refresh={refresh} notify={notify} onClose={closeStatus} onOpenDetails={openEditedIssue} />}
  </div>;
}

function StatusDialog({ edit, latest, refresh, notify, onClose, onOpenDetails }: {
  edit: StatusEdit;
  latest: WorkspaceSnapshot;
  refresh: Props['refresh'];
  notify: Props['notify'];
  onClose: () => void;
  onOpenDetails: () => void;
}) {
  const heading = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const statusField = useRef<HTMLSelectElement>(null);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(edit.choices.length === 1 ? edit.choices[0].id : '');
  const [error, setError] = useState('');
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [rejected, setRejected] = useState(false);
  const current = latest.issues.find(issue => issue.id === edit.issue.id);
  const stale = !current || current.version !== edit.issue.version || current.projectId !== edit.issue.projectId ||
    projectWorkflow(latest, edit.issue.projectId).version !== edit.workflowVersion;

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    statusField.current?.focus({ preventScroll: true });
    return () => element?.close();
  }, []);

  useEffect(() => {
    const guard = (event: Event) => {
      if (event.defaultPrevented) return;
      if (pending.current) { event.preventDefault(); return; }
      if (recovery === 'verify' && !window.confirm('상태 변경 결과를 확인하지 못했습니다. 닫을까요?')) { event.preventDefault(); return; }
      afterAcceptedNavigation(event, onClose);
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (!pending.current && recovery !== 'verify') return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('teamspace:navigate', guard);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('teamspace:navigate', guard);
      window.removeEventListener('beforeunload', unload);
    };
  }, [onClose, recovery]);

  function close() {
    if (!pending.current && (recovery !== 'verify' || window.confirm('상태 변경 결과를 확인하지 못했습니다. 닫을까요?'))) onClose();
  }

  async function committed() {
    setRecovery('refresh');
    try {
      await refresh();
      notify(`${edit.issue.key} · ${edit.choices.find(status => status.id === selected)?.label ?? selected}(으)로 변경했습니다.`);
      onClose();
    } catch { setError(REFRESH); }
  }

  async function verify() {
    let snapshot: WorkspaceSnapshot;
    try { snapshot = await api<WorkspaceSnapshot>('/workspace', { cache: 'no-store' }); }
    catch { setRecovery('verify'); setError(UNKNOWN); return; }
    const confirmed = snapshot.issues.find(issue => issue.id === edit.issue.id && issue.projectId === edit.issue.projectId);
    if (confirmed && confirmed.status === selected && confirmed.version > edit.issue.version) { await committed(); return; }
    if (confirmed?.version === edit.issue.version && confirmed.status === edit.issue.status &&
      projectWorkflow(snapshot, edit.issue.projectId).version === edit.workflowVersion) {
      setRecovery(null);
      setError('서버의 업무 상태는 그대로입니다. 상태 변경을 다시 적용할 수 있습니다.');
    } else { setRecovery('conflict'); setError(STALE); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!selected || stale || recovery || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setRejected(false);
    try {
      const updated = await patch<Issue>(`/issues/${encodeURIComponent(edit.issue.id)}`, {
        expectedVersion: edit.issue.version, expectedWorkflowVersion: edit.workflowVersion, status: selected,
      });
      if (updated?.id !== edit.issue.id || updated.projectId !== edit.issue.projectId || updated.status !== selected || updated.version <= edit.issue.version) throw new Error(UNKNOWN);
      await committed();
    } catch (cause) {
      if (cause instanceof ApiError && (cause.status === 409 || cause.status === 404)) { setRecovery('conflict'); setError(cause.message); }
      else if (cause instanceof ApiError && cause.status < 500 && ![408, 425, 429, 499].includes(cause.status)) {
        setError(errorMessage(cause));
        setRejected(cause.status === 422);
      }
      else await verify();
    } finally { pending.current = false; setBusy(false); }
  }

  async function recover() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      if (recovery === 'verify') await verify();
      else if (recovery === 'refresh') await committed();
      else { await refresh(); onClose(); }
    } catch (cause) { setError(errorMessage(cause)); }
    finally { pending.current = false; setBusy(false); }
  }

  return <dialog ref={dialog} className="team-board-status-dialog" aria-labelledby={heading} aria-busy={busy}
    onCancel={event => { event.preventDefault(); close(); }}>
    <form onSubmit={event => void submit(event)}>
      <header><h2 id={heading}>업무 상태 변경</h2>
        <button className="btn btn-ghost issue-icon-button" type="button" aria-label="상태 변경 닫기" disabled={busy} onClick={close}><X size={17} aria-hidden="true" /></button>
      </header>
      <div className="team-board-status-body">
        <p><strong>{edit.issue.key}</strong> · {edit.issue.title}</p>
        <p>현재 상태 <StatusDot color={edit.current.color} />{edit.current.label}</p>
        <label>변경할 상태
          <select ref={statusField} className="field" value={selected} required disabled={busy || stale || Boolean(recovery)}
            onChange={event => { setSelected(event.currentTarget.value); setError(''); setRejected(false); }}>
            <option value="" disabled>상태 선택</option>
            {edit.choices.map(status => <option key={status.id} value={status.id}>{status.label}</option>)}
          </select>
        </label>
        {(error || stale && !busy) && <p className="issue-form-error" role="alert">{error || STALE}</p>}
        {rejected && !busy && <button className="btn btn-ghost team-board-status-details" type="button" onClick={onOpenDetails}>업무 상세에서 확인</button>}
      </div>
      <footer>
        <button className="btn btn-ghost" type="button" onClick={close} disabled={busy}>취소</button>
        {recovery || stale ? <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void recover()}>
          {recovery === 'verify' ? '최신 상태 확인' : '최신 업무 불러오기'}
        </button> : <button className="btn btn-primary" type="submit" disabled={busy || !selected}>상태 변경 적용</button>}
      </footer>
    </form>
  </dialog>;
}
