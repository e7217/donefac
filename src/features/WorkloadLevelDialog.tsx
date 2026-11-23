'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { CalendarClock, Check, RefreshCw, X } from 'lucide-react';
import type { Issue, Project, ScheduleUndoScope, TeamWorkloadLevelPreview, User, WorkloadLevelPreview } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { formatWorklogMinutes } from '../lib/worklogs';
import type { ScheduleApplyResult } from './AutomaticScheduleDialog';
import { errorMessage } from './schedule-utils';
import { scheduleUndoHeaders } from './schedule-undo';
import './workload-level.css';

const WORKLOAD_LEVEL_DRAFT = 'workload-level';
const PAGE_SIZE = 15;
type Pending = 'preview' | 'apply' | 'receipt' | 'refresh';
type Receipt = ScheduleApplyResult | { applied: false };

type TeamScope = {
  projectIds: string[];
  projects: ReadonlyMap<string, Project>;
};

type Props = {
  actorId: string;
  undoScope: ScheduleUndoScope;
  startDate: string;
  endDate: string;
  initialUserId?: string;
  availableUserIds: string[];
  users: ReadonlyMap<string, User>;
  issues: ReadonlyMap<string, Issue>;
  onDraftChange?: (id: string, dirty: boolean, pending?: boolean) => void;
  onClose: () => void;
  onApplied: (result: ScheduleApplyResult) => Promise<void> | void;
} & (
  | { projectId: string; projectName: string; selectedIssueIds?: string[]; team?: never }
  | { team: TeamScope; projectId?: never; projectName?: never; selectedIssueIds?: never }
);

type Preview = WorkloadLevelPreview | TeamWorkloadLevelPreview;

function isApplyResult(value: Receipt | null): value is ScheduleApplyResult {
  return Boolean(value && typeof value === 'object' && 'undoId' in value && typeof value.undoId === 'string' && value.undoId && Array.isArray(value.updated));
}

export function WorkloadLevelDialog({ projectId, projectName, team, actorId, undoScope, startDate, endDate, initialUserId = '', availableUserIds,
  selectedIssueIds, users, issues, onDraftChange, onClose, onApplied }: Props) {
  const titleId = useId();
  const descriptionId = `${titleId}-description`;
  const dialog = useRef<HTMLDialogElement>(null);
  const assigneeInput = useRef<HTMLSelectElement>(null);
  const request = useRef<AbortController | null>(null);
  const [userId, setUserId] = useState(initialUserId);
  const [selectedIds] = useState(() => selectedIssueIds ?? []);
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState('');
  const [expired, setExpired] = useState(false);
  const [applyRejected, setApplyRejected] = useState(false);
  const [receiptUnknown, setReceiptUnknown] = useState(false);
  const [applied, setApplied] = useState<ScheduleApplyResult | null>(null);
  const [changePage, setChangePage] = useState(0);
  const [remainingPage, setRemainingPage] = useState(0);
  const [completionPage, setCompletionPage] = useState(0);
  const dirty = !applied && Boolean(userId !== initialUserId || selectedOnly || preview || receiptUnknown);
  const busy = pending !== null;
  const loadBlocked = !availableUserIds.length || Boolean(userId && !availableUserIds.includes(userId)) || team?.projectIds.length === 0;
  const headers = { 'X-Actor-Id': actorId };
  const title = team ? '프로젝트 간 과부하 조정' : '과부하 일정 조정';
  const route = team ? '/schedule/team-workload' : '/schedule/workload';
  const projectCompletions = preview && 'projectCompletions' in preview ? preview.projectCompletions : [];
  const projectTitle = (id: string) => team?.projects.get(id)?.name ?? id;

  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement;
    if (!element) return;
    element.showModal();
    assigneeInput.current?.focus({ preventScroll: true });
    return () => {
      request.current?.abort();
      request.current = null;
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    onDraftChange?.(WORKLOAD_LEVEL_DRAFT, dirty, busy);
  }, [busy, dirty, onDraftChange]);
  useEffect(() => () => onDraftChange?.(WORKLOAD_LEVEL_DRAFT, false), [onDraftChange]);
  useEffect(() => {
    if (!preview) return;
    const remaining = Date.parse(preview.expiresAt) - Date.now();
    const timer = setTimeout(() => setExpired(true), Math.max(0, remaining));
    return () => clearTimeout(timer);
  }, [preview]);

  function close() {
    if (request.current) return;
    const confirmation = receiptUnknown
      ? '적용 결과를 아직 확인하지 못했습니다. 결과 확인을 중단하고 닫을까요?'
      : '조정 조건과 미리보기를 버리고 닫을까요?';
    if (dirty && !window.confirm(confirmation)) return;
    onDraftChange?.(WORKLOAD_LEVEL_DRAFT, false);
    onClose();
  }

  function clearPreview() {
    setPreview(null);
    setError('');
  }

  async function run(kind: Pending, action: (signal: AbortSignal) => Promise<void>) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(kind);
    setError('');
    onDraftChange?.(WORKLOAD_LEVEL_DRAFT, dirty, true);
    try {
      await action(controller.signal);
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (request.current === controller) {
        request.current = null;
        setPending(null);
      }
    }
  }

  function requestPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loadBlocked || applied || receiptUnknown) return;
    void run('preview', async signal => {
      setApplyRejected(true);
      const scope = team ? { projectIds: team.projectIds } : { projectId, ...(selectedOnly ? { issueIds: selectedIds } : {}) };
      const result = await api<Preview>(`${route}-preview`, {
        method: 'POST', headers, signal,
        body: JSON.stringify({ ...scope, startDate, endDate, ...(userId ? { userIds: [userId] } : {}) }),
      });
      if (signal.aborted) return;
      setPreview(result);
      setChangePage(0);
      setCompletionPage(0);
      setRemainingPage(0);
      setExpired(!(Date.parse(result.expiresAt) > Date.now()));
      setApplyRejected(false);
    });
  }

  async function reflect(result: ScheduleApplyResult, signal: AbortSignal) {
    if (signal.aborted) return;
    setReceiptUnknown(false);
    setApplied(result);
    try {
      await onApplied(result);
      if (!signal.aborted) onClose();
    } catch (cause) {
      if (!signal.aborted) setError(`일정이 적용되었습니다. 화면 갱신을 다시 시도해 주세요. ${errorMessage(cause)}`);
    }
  }

  async function checkReceipt(previewId: string, signal: AbortSignal) {
    const receipt = await api<Receipt>(`${route}-result/${encodeURIComponent(previewId)}`, { headers, signal });
    if (signal.aborted) return;
    if (isApplyResult(receipt)) await reflect(receipt, signal);
    else if (receipt?.applied === false) {
      setReceiptUnknown(false);
      setError('저장된 적용 결과가 없습니다. 같은 미리보기로 다시 적용할 수 있습니다.');
    } else throw new Error('서버의 적용 기록을 확인할 수 없습니다.');
  }

  function apply() {
    if (!preview || preview.blocking.length || !preview.changes.length || applyRejected || receiptUnknown || applied) return;
    if (expired || !(Date.parse(preview.expiresAt) > Date.now())) {
      setExpired(true);
      return;
    }
    void run('apply', async signal => {
      let result: ScheduleApplyResult;
      try {
        const response = await api<ScheduleApplyResult>(`${route}-apply`, {
          method: 'POST', headers: scheduleUndoHeaders(undoScope, actorId), signal, body: JSON.stringify({ previewId: preview.previewId }),
        });
        if (!isApplyResult(response)) throw new Error('적용 응답을 확인하지 못했습니다.');
        result = response;
      } catch (cause) {
        if (signal.aborted) return;
        if (cause instanceof ApiError && [400, 401, 403, 404, 409, 413, 422].includes(cause.status)) {
          setApplyRejected(true);
          throw cause;
        }
        setReceiptUnknown(true);
        await checkReceipt(preview.previewId, signal);
        return;
      }
      await reflect(result, signal);
    });
  }

  const canApply = Boolean(preview && !preview.blocking.length && preview.changes.length && !expired && !applyRejected);
  return <dialog ref={dialog} aria-labelledby={titleId} aria-describedby={descriptionId} className="workload-level-dialog" onCancel={event => { event.preventDefault(); close(); }}>
    <header>
      <div><h2 id={titleId}><CalendarClock size={20} aria-hidden="true" />{title}</h2><p>{projectName && <>{projectName} · </>}{startDate} ~ {endDate}</p></div>
      <button className="issue-icon-button" type="button" aria-label={`${title} 닫기`} disabled={busy} onClick={close}><X size={20} /></button>
    </header>
    <div className="workload-level-body" aria-busy={busy}>
      <form onSubmit={requestPreview}>
        <p id={descriptionId}>{team ? '모든 프로젝트의 작업량과 팀 가용 시간을 비교하고, 선택한 프로젝트의 업무만 각 프로젝트의 근무일과 마감일, 업무 연결을 지켜 뒤로 옮깁니다.' :
          '근무일 수와 마감일, 업무 연결을 지키면서 가용 시간이 있는 날짜로 업무를 미룹니다.'}</p>
        {team && <details className="workload-level-projects" open={team.projectIds.length <= 4}>
          <summary>이동할 프로젝트 <small>{team.projectIds.length.toLocaleString('ko-KR')}개</small></summary>
          <ul>{team.projectIds.map(id => <li key={id}>{projectTitle(id)}</li>)}</ul>
        </details>}
        <div className="workload-level-form-row">
          <label>조정 대상 담당자
            <select ref={assigneeInput} aria-label="조정 대상 담당자" className="field" value={userId}
              disabled={busy || receiptUnknown || Boolean(applied)} onChange={event => { setUserId(event.target.value); clearPreview(); }}>
              <option value="">전체 담당자</option>
              {availableUserIds.map(id => <option key={id} value={id}>{users.get(id)?.name ?? id}</option>)}
            </select>
          </label>
          <button className="btn" type="submit" disabled={busy || loadBlocked || receiptUnknown || Boolean(applied)}>
            <RefreshCw size={14} aria-hidden="true" />{pending === 'preview' ? '계산 중…' : '과부하 조정 미리보기'}
          </button>
        </div>
        {selectedIds.length > 0 && <label className="workload-level-selected">
          <input type="checkbox" checked={selectedOnly} disabled={busy || receiptUnknown || Boolean(applied)}
            onChange={event => { setSelectedOnly(event.target.checked); clearPreview(); }} />
          간트에서 선택한 업무만 이동 <small>({selectedIds.length.toLocaleString('ko-KR')}개)</small>
        </label>}
      </form>
      {preview && <>
        <WorkloadLevelSummary preview={preview} team={Boolean(team)} />
        {projectCompletions.length > 0 && <section className="workload-level-section" aria-label="프로젝트별 계획 종료일">
          <h3>프로젝트별 계획 종료일</h3>
          <table className="workload-level-changes" aria-label="프로젝트별 계획 종료일">
            <thead><tr><th scope="col">프로젝트</th><th scope="col">현재 종료일</th><th scope="col">제안 종료일</th></tr></thead>
            <tbody>{projectCompletions.slice(completionPage * PAGE_SIZE, (completionPage + 1) * PAGE_SIZE).map(project => <tr key={project.projectId}>
              <th scope="row">{projectTitle(project.projectId)}</th><td>{project.before ?? '미정'}</td><td>{project.after ?? '미정'}</td>
            </tr>)}</tbody>
          </table>
          <ResultPaging title="프로젝트" count={projectCompletions.length} page={completionPage} disabled={busy} onChange={setCompletionPage} />
        </section>}
        {preview.changes.length ? <section className="workload-level-section" aria-label="조정 제안 업무">
          <h3>조정 제안 업무 <small>{preview.changes.length.toLocaleString('ko-KR')}개</small></h3>
          <table className="workload-level-changes" aria-label="조정 제안 업무">
            <thead><tr><th scope="col">업무</th><th scope="col">현재 일정</th><th scope="col">제안 일정</th></tr></thead>
            <tbody>{preview.changes.slice(changePage * PAGE_SIZE, (changePage + 1) * PAGE_SIZE).map(change => {
              const changedProjectId = 'projectId' in change && typeof change.projectId === 'string' ? change.projectId : issues.get(change.id)?.projectId;
              return <tr key={change.id}>
                <th scope="row">{team && changedProjectId && <span className="workload-level-project-name">{projectTitle(changedProjectId)}</span>}
                  <small>{change.key}</small><span>{change.title}</span></th>
                <td><DatePair start={change.fromStart} end={change.fromEnd} /></td><td><DatePair start={change.toStart} end={change.toEnd} /></td>
              </tr>;
            })}</tbody>
          </table>
          <ResultPaging title="업무" count={preview.changes.length} page={changePage} disabled={busy} onChange={setChangePage} />
        </section> : <p className="workload-level-info">현재 조건에서 조정할 일정이 없습니다.</p>}
        {preview.after.overloadedCells > 0 && <section className="workload-level-section workload-level-remaining" aria-label="남은 과부하">
          <h3>남은 과부하 <small>{preview.after.overloadedCells.toLocaleString('ko-KR')} 담당자·일</small></h3>
          <ul>{preview.remaining.slice(remainingPage * PAGE_SIZE, (remainingPage + 1) * PAGE_SIZE).map(conflict => <li key={`${conflict.userId}:${conflict.date}`}>
            <strong>{users.get(conflict.userId)?.name ?? conflict.userId} · <time dateTime={conflict.date}>{conflict.date}</time></strong>
            <span>{formatWorklogMinutes(conflict.excessMinutes)} 초과</span>
            <small>{conflict.issueIds.map(id => {
              const issue = issues.get(id);
              return issue && team ? `${projectTitle(issue.projectId)} · ${issue.key}` : issue?.key ?? id;
            }).join(', ')}</small>
          </li>)}</ul>
          <ResultPaging title="과부하" count={preview.remaining.length} page={remainingPage} disabled={busy} onChange={setRemainingPage} />
          {preview.remaining.length < preview.after.overloadedCells && <p>남은 과부하 중 {preview.remaining.length}건의 업무 상세를 표시합니다.</p>}
        </section>}
        <PreviewMessages preview={preview} />
        {expired && !applied && !receiptUnknown && <p className="workload-level-info" role="status">미리보기가 만료되었습니다. 다시 계산해 주세요.</p>}
      </>}
      {receiptUnknown && <p className="workload-level-info" role="status">같은 미리보기의 적용 기록을 다시 확인할 수 있습니다.</p>}
      {error && <p className="workload-level-error" role="alert">{error}</p>}
    </div>
    <footer>
      <span>적용 후 간트에서 되돌릴 수 있습니다.</span>
      <button className="btn btn-ghost" type="button" disabled={busy} onClick={close}>닫기</button>
      {applied ? <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void run('refresh', signal => reflect(applied, signal))}>화면 다시 불러오기</button>
        : receiptUnknown && preview ? <button className="btn btn-primary" type="button" disabled={busy}
          onClick={() => void run('receipt', signal => checkReceipt(preview.previewId, signal))}>적용 결과 다시 확인</button>
          : preview && <button className="btn btn-primary" type="button" disabled={busy || !canApply} onClick={apply}>
            <Check size={15} aria-hidden="true" />{pending === 'apply' ? '적용 중…' : '과부하 조정 적용'}
          </button>}
    </footer>
  </dialog>;
}

function WorkloadLevelSummary({ preview: { before, after }, team }: { preview: WorkloadLevelPreview; team: boolean }) {
  return <section className="workload-level-section" aria-label="조정 전후 작업량">
    <h3>조정 전후 작업량</h3>
    <dl className="workload-level-summary">
      <div><dt>초과한 담당자·일</dt><dd>{before.overloadedCells.toLocaleString('ko-KR')} → {after.overloadedCells.toLocaleString('ko-KR')}</dd></div>
      <div><dt>초과 시간</dt><dd>{formatWorklogMinutes(before.excessMinutes)} → {formatWorklogMinutes(after.excessMinutes)}</dd></div>
      <div><dt>{team ? '전체 프로젝트 계획 종료일' : '프로젝트 계획 종료일'}</dt><dd>{before.completionDate ?? '미정'} → {after.completionDate ?? '미정'}</dd></div>
    </dl>
  </section>;
}

function DatePair({ start, end }: { start: string | null; end: string | null }) {
  return <>{start ?? '미정'}{start !== end && <><br />{end ?? '미정'}</>}</>;
}

function ResultPaging({ title, count, page, disabled, onChange }: {
  title: string; count: number; page: number; disabled: boolean; onChange: (page: number) => void;
}) {
  if (count <= PAGE_SIZE) return null;
  return <div className="workload-page-actions" role="group" aria-label={`${title} 페이지`}>
    <span>{page * PAGE_SIZE + 1}~{Math.min((page + 1) * PAGE_SIZE, count)} / {count.toLocaleString('ko-KR')}</span>
    <button className="btn btn-ghost" type="button" onClick={() => onChange(page - 1)} disabled={disabled || page === 0}>이전 {title}</button>
    <button className="btn btn-ghost" type="button" onClick={() => onChange(page + 1)} disabled={disabled || (page + 1) * PAGE_SIZE >= count}>다음 {title}</button>
  </div>;
}

function PreviewMessages({ preview }: { preview: WorkloadLevelPreview }) {
  if (!preview.blocking.length && !preview.warnings.length && !preview.reason) return null;
  return <section className="workload-level-section workload-level-messages" aria-label="미리보기 안내">
    {preview.reason === 'search-limit' && <p>계산 한도에 도달했습니다. 기간이나 담당자를 좁혀 다시 미리 보세요.</p>}
    {preview.blocking.length > 0 && <details open>
      <summary>적용할 수 없는 조건 {preview.blocking.length}건</summary>
      <PreviewMessageList messages={preview.blocking} />
    </details>}
    {preview.warnings.length > 0 && <details>
      <summary>일정 확인 사항 {preview.warnings.length}건</summary>
      <PreviewMessageList messages={preview.warnings} />
    </details>}
  </section>;
}

function PreviewMessageList({ messages }: { messages: string[] }) {
  return <>
    <ul>{messages.slice(0, PAGE_SIZE).map((message, index) => <li key={index}>{message}</li>)}</ul>
    {messages.length > PAGE_SIZE && <p>처음 {PAGE_SIZE}건을 표시합니다.</p>}
  </>;
}
