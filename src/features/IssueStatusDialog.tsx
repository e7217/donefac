'use client';

import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { FeatureProps, Issue, IssueChangeHistoryPage, IssueStatusChangeRequest, IssueStatusChangeResult, User, WorkflowStatus, WorkspaceSnapshot } from '../../shared/types';
import { allowedNextStatuses, projectWorkflow, statusMeta } from '../../shared/workflow-helpers';
import { api, ApiError, patch } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import { newRequestId } from '../lib/request-id';
import { CommentMentionInput, commentDraftPayload, emptyCommentDraft } from './CommentMentions';
import { errorMessage } from './schedule-utils';
import './issue-status-dialog.css';

export type IssueStatusEdit = { issue: Issue; current: WorkflowStatus; choices: WorkflowStatus[]; workflowVersion: number };
type Recovery = 'conflict' | 'verify' | 'verify-comment' | 'refresh';
type HandoffAttempt = { actorId: string; input: IssueStatusChangeRequest };

const STALE = '업무 또는 프로젝트 워크플로가 변경되었습니다. 최신 상태를 불러온 뒤 다시 선택해 주세요.';
const REFRESH = '변경 사항을 저장했습니다. 화면에 반영하려면 최신 업무를 불러와 주세요.';
const UNKNOWN_HANDOFF = '상태 변경과 인수인계 댓글의 저장 결과를 확인하지 못했습니다.';
const UNASSIGNED = 'unassigned';
const USER_OPTION = 'user:';

function confirmedHandoff(result: IssueStatusChangeResult, edit: IssueStatusEdit, input: IssueStatusChangeRequest): boolean {
  const { issue, receipt, duplicate } = result ?? {};
  return Boolean(receipt && issue && typeof duplicate === 'boolean' && receipt.requestId === input.requestId &&
    receipt.issueId === edit.issue.id && receipt.projectId === edit.issue.projectId && receipt.appliedVersion === input.expectedVersion + 1 &&
    receipt.status === input.status && (receipt.assigneeId === null || typeof receipt.assigneeId === 'string') &&
    (input.assigneeId === undefined || receipt.assigneeId === input.assigneeId) && typeof receipt.commentId === 'string' && receipt.commentId.length > 0 &&
    issue.id === receipt.issueId && issue.projectId === receipt.projectId && Number.isSafeInteger(issue.version) &&
    (issue.version === receipt.appliedVersion ? issue.status === receipt.status && issue.assigneeId === receipt.assigneeId :
      duplicate && issue.version > receipt.appliedVersion));
}

function definiteStatusError(cause: unknown): cause is ApiError {
  return cause instanceof ApiError && cause.status < 500 && ![408, 425, 429, 499].includes(cause.status);
}

export function IssueStatusDialog({ edit: originalEdit, actorId, latest, refresh, notify, onClose, onOpenDetails }: {
  edit: IssueStatusEdit;
  actorId: string;
  latest: WorkspaceSnapshot;
  refresh: FeatureProps['refresh'];
  notify: FeatureProps['notify'];
  onClose: () => void;
  onOpenDetails: () => void;
}) {
  const [review, setReview] = useState(() => ({ edit: originalEdit, restoreGeneration: latest.restoreGeneration }));
  const { edit, restoreGeneration } = review;
  const heading = useId();
  const errorId = useId();
  const commentId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const statusField = useRef<HTMLSelectElement>(null);
  const assigneeField = useRef<HTMLSelectElement>(null);
  const recoverButton = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const handoffAttempt = useRef<HandoffAttempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(edit.choices.length === 1 ? edit.choices[0].id : '');
  const [assigneeId, setAssigneeId] = useState<Issue['assigneeId'] | undefined>();
  const [comment, setComment] = useState(emptyCommentDraft);
  const [commentSaved, setCommentSaved] = useState(false);
  const [error, setError] = useState('');
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [assigneeRequired, setAssigneeRequired] = useState(false);
  const current = latest.issues.find(issue => issue.id === edit.issue.id);
  const stale = latest.restoreGeneration !== restoreGeneration || !current || current.version !== edit.issue.version || current.projectId !== edit.issue.projectId ||
    projectWorkflow(latest, edit.issue.projectId).version !== edit.workflowVersion;
  const assigneeUnavailable = typeof assigneeId === 'string' && !latest.users.some(user => user.id === assigneeId);
  const assigneeOption = assigneeId === undefined ? '' : assigneeId === null ? UNASSIGNED : `${USER_OPTION}${assigneeId}`;
  const unknownResult = `${assigneeId === undefined ? '상태' : '상태와 담당자'} 변경 결과를 확인하지 못했습니다.`;
  const discardPrompt = recovery === 'verify-comment' ? `${UNKNOWN_HANDOFF} 닫을까요?` : recovery === 'verify' ? `${unknownResult} 닫을까요?` :
    comment.body.trim() ? '작성 중인 인수인계 댓글을 버리고 닫을까요?' : null;
  const nameCounts = new Map<string, number>();
  for (const user of latest.users) nameCounts.set(user.name, (nameCounts.get(user.name) ?? 0) + 1);

  function assigneeLabel(user: User) {
    return (nameCounts.get(user.name) ?? 0) > 1 ? `${user.name} · ${user.email}` : user.name;
  }

  function assigneeName(id: Issue['assigneeId']) {
    if (id === null) return '미지정';
    const user = latest.users.find(person => person.id === id);
    return user ? assigneeLabel(user) : '팀원 확인 불가';
  }

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    statusField.current?.focus({ preventScroll: true });
    return () => element?.close();
  }, []);

  useEffect(() => {
    if (!busy && assigneeRequired) assigneeField.current?.focus();
  }, [assigneeRequired, busy]);

  useEffect(() => {
    if (!busy && recovery === 'verify-comment') recoverButton.current?.focus();
  }, [busy, recovery]);

  useEffect(() => {
    const guard = (event: Event) => {
      if (event.defaultPrevented) return;
      if (pending.current) { event.preventDefault(); return; }
      if (discardPrompt && !window.confirm(discardPrompt)) { event.preventDefault(); return; }
      afterAcceptedNavigation(event, onClose);
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (!pending.current && !discardPrompt) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('teamspace:navigate', guard);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('teamspace:navigate', guard);
      window.removeEventListener('beforeunload', unload);
    };
  }, [onClose, discardPrompt]);

  function close() {
    if (!pending.current && (!discardPrompt || window.confirm(discardPrompt))) onClose();
  }

  function clearValidation() {
    setError('');
    setShowDetails(false);
    setAssigneeRequired(false);
  }

  function matchesChange(issue: Issue | undefined): boolean {
    return Boolean(issue && issue.id === edit.issue.id && issue.projectId === edit.issue.projectId &&
      issue.status === selected && Number.isSafeInteger(issue.version) && issue.version > edit.issue.version &&
      (assigneeId === undefined || issue.assigneeId === assigneeId));
  }

  async function committed(withComment = commentSaved) {
    setRecovery('refresh');
    try {
      await refresh();
      const label = edit.choices.find(status => status.id === selected)?.label ?? selected;
      const details = assigneeId === undefined ? '' : ` · 담당자 ${assigneeName(assigneeId)}`;
      notify(withComment ? `${edit.issue.key} · 상태 ${label}${details} · 인수인계 댓글 저장 완료` :
        assigneeId === undefined ? `${edit.issue.key} · ${label}(으)로 변경했습니다.` : `${edit.issue.key} · 상태 ${label}${details} 저장 완료`);
      onClose();
    } catch { setError(REFRESH); }
  }

  async function verify() {
    try {
      const snapshot = await api<WorkspaceSnapshot>('/workspace', { cache: 'no-store' });
      if (!Array.isArray(snapshot?.issues)) throw new Error(unknownResult);
      const confirmed = snapshot.restoreGeneration === restoreGeneration
        ? snapshot.issues.find(issue => issue.id === edit.issue.id && issue.projectId === edit.issue.projectId)
        : undefined;
      if (confirmed?.version === edit.issue.version && confirmed.status === edit.issue.status && confirmed.assigneeId === edit.issue.assigneeId &&
        projectWorkflow(snapshot, edit.issue.projectId).version === edit.workflowVersion) {
        setRecovery(null);
        setError('서버의 업무가 변경되지 않았습니다. 다시 적용할 수 있습니다.');
        return;
      }

      let message = STALE;
      if (confirmed && confirmed.version > edit.issue.version) {
        const appliedVersion = edit.issue.version + 1;
        const history = await api<IssueChangeHistoryPage>(`/issues/${encodeURIComponent(edit.issue.id)}/change-history?beforeVersion=${appliedVersion + 1}`,
          { cache: 'no-store' });
        if (!Array.isArray(history?.entries)) throw new Error(unknownResult);
        const entry = history.entries.find(row => row.issueId === edit.issue.id && row.issueVersion === appliedVersion &&
          row.projectId === edit.issue.projectId && row.previousProjectId === edit.issue.projectId);
        const statusChange = entry?.changes.find(change => change.field === 'status');
        const assigneeChange = entry?.changes.find(change => change.field === 'assigneeId');
        const transitioned = statusChange?.before.value === edit.issue.status && statusChange.after.value === selected;
        const assigned = assigneeId === undefined || (assigneeChange ? assigneeChange.after.value : edit.issue.assigneeId) === assigneeId;
        if (transitioned && assigned && entry) {
          if (entry.origin === 'user' && entry.actorId === actorId) { await committed(); return; }
          message = '선택한 변경을 다른 작업자가 먼저 저장했습니다. 최신 업무를 불러와 주세요.';
        } else if (confirmed.status === selected && assigneeId !== undefined && confirmed.assigneeId !== assigneeId) {
          message = '업무 상태가 바뀌었고 실제 담당자가 선택한 값과 다릅니다. 최신 업무를 확인해 주세요.';
        }
      }
      setRecovery('conflict');
      setError(message);
    } catch {
      setRecovery('verify');
      setError(`${unknownResult} 최신 업무를 확인해 주세요.`);
    }
  }

  function reportStatusError(cause: ApiError) {
    setError(errorMessage(cause));
    if (cause.status === 409 || cause.status === 404) {
      setRecovery('conflict');
      return;
    }
    setRecovery(null);
    const details = cause.details;
    const requiredFields = typeof details === 'object' && details !== null && 'requiredFields' in details &&
      Array.isArray(details.requiredFields) ? details.requiredFields : [];
    const missingAssignee = cause.status === 422 && requiredFields.includes('assigneeId');
    setAssigneeRequired(missingAssignee);
    setShowDetails(cause.status === 422 && (!missingAssignee || requiredFields.length > 1));
  }

  async function applyHandoff(attempt: HandoffAttempt) {
    if (attempt.actorId !== actorId) {
      setError('작성한 작업자로 전환한 뒤 저장 결과를 다시 확인해 주세요.');
      return;
    }
    try {
      const result = await api<IssueStatusChangeResult>(`/issues/${encodeURIComponent(edit.issue.id)}/status-change`, {
        method: 'POST', headers: { 'X-Actor-Id': attempt.actorId }, body: JSON.stringify(attempt.input),
      });
      if (!confirmedHandoff(result, edit, attempt.input)) throw new Error(UNKNOWN_HANDOFF);
      handoffAttempt.current = null;
      setComment(emptyCommentDraft());
      setCommentSaved(true);
      await committed(true);
    } catch (cause) {
      if (definiteStatusError(cause)) {
        if (recovery === 'verify-comment' && (cause.status === 401 || cause.status === 403)) {
          setError(`${UNKNOWN_HANDOFF} 접속을 확인한 뒤 같은 요청으로 다시 확인해 주세요.`);
          return;
        }
        handoffAttempt.current = null;
        reportStatusError(cause);
      } else {
        setRecovery('verify-comment');
        setError(`${UNKNOWN_HANDOFF} 같은 요청으로 다시 확인해 주세요.`);
      }
    }
  }

  async function reviewLatestWithComment() {
    const snapshot = await api<WorkspaceSnapshot>('/workspace', { cache: 'no-store' });
    if (typeof snapshot?.restoreGeneration !== 'string' || !Array.isArray(snapshot?.issues)) {
      throw new Error('최신 업무 정보를 불러오지 못했습니다.');
    }
    const issue = snapshot.issues.find(issue => issue.id === edit.issue.id && issue.projectId === edit.issue.projectId);
    if (!issue) {
      setError('현재 프로젝트에서 업무를 찾을 수 없습니다. 작성한 댓글을 확인해 주세요.');
      return;
    }
    const choices = allowedNextStatuses(snapshot, issue).filter(status => status.id !== issue.status);
    await refresh();
    setReview({ restoreGeneration: snapshot.restoreGeneration, edit: { issue, choices,
      current: statusMeta(snapshot, issue.projectId, issue.status), workflowVersion: projectWorkflow(snapshot, issue.projectId).version } });
    clearValidation();
    setRecovery(null);
    setSelected('');
    if (!choices.length) {
      setError('현재 업무에서 변경할 수 있는 상태가 없습니다. 작성한 댓글을 확인해 주세요.');
      setShowDetails(true);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!selected || assigneeUnavailable || stale || recovery || pending.current) return;
    const note = commentDraftPayload(comment);
    pending.current = true;
    setBusy(true);
    clearValidation();
    try {
      if (note.body) {
        if (!restoreGeneration) {
          setRecovery('conflict');
          setError('현재 작업 공간을 확인하려면 최신 업무를 불러와 주세요.');
          return;
        }
        const attempt = { actorId, input: { requestId: newRequestId(), restoreGeneration, expectedVersion: edit.issue.version,
          expectedWorkflowVersion: edit.workflowVersion, status: selected, ...(assigneeId === undefined ? {} : { assigneeId }), comment: note } };
        handoffAttempt.current = attempt;
        await applyHandoff(attempt);
        return;
      }
      const updated = await patch<Issue>(`/issues/${encodeURIComponent(edit.issue.id)}`, {
        expectedVersion: edit.issue.version, expectedWorkflowVersion: edit.workflowVersion, status: selected,
        ...(assigneeId === undefined ? {} : { assigneeId }),
      });
      if (!matchesChange(updated) || updated?.version !== edit.issue.version + 1) throw new Error(unknownResult);
      await committed();
    } catch (cause) {
      if (definiteStatusError(cause)) reportStatusError(cause);
      else if (note.body) setError(errorMessage(cause));
      else await verify();
    } finally { pending.current = false; setBusy(false); }
  }

  async function recover() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      if (recovery === 'verify') await verify();
      else if (recovery === 'verify-comment' && handoffAttempt.current) await applyHandoff(handoffAttempt.current);
      else if (recovery === 'refresh') await committed();
      else if (comment.body.trim()) await reviewLatestWithComment();
      else { await refresh(); onClose(); }
    } catch (cause) { setError(errorMessage(cause)); }
    finally { pending.current = false; setBusy(false); }
  }

  return <dialog ref={dialog} className="issue-status-dialog" aria-labelledby={heading} aria-busy={busy}
    onCancel={event => { event.preventDefault(); close(); }}>
    <form onSubmit={event => void submit(event)}>
      <header><h2 id={heading}>업무 상태 변경</h2>
        <button className="btn btn-ghost issue-icon-button" type="button" aria-label="상태 변경 닫기" disabled={busy} onClick={close}><X size={17} aria-hidden="true" /></button>
      </header>
      <div className="issue-status-dialog-body">
        <p><strong>{edit.issue.key}</strong> · {edit.issue.title}</p>
        <p>현재 상태 <span aria-hidden="true" className="issue-status-dot" style={{ background: edit.current.color }} />{edit.current.label}</p>
        <p>현재 담당자 {assigneeName(edit.issue.assigneeId)}</p>
        <label>변경할 상태
          <select ref={statusField} className="field" value={selected} required disabled={busy || stale || Boolean(recovery)}
            onChange={event => { setSelected(event.currentTarget.value); clearValidation(); }}>
            <option value="" disabled>상태 선택</option>
            {edit.choices.map(status => <option key={status.id} value={status.id}>{status.label}</option>)}
          </select>
        </label>
        <label>담당자
          <select ref={assigneeField} className="field" value={assigneeOption} disabled={busy || stale || Boolean(recovery)}
            aria-invalid={assigneeRequired || assigneeUnavailable || undefined}
            aria-describedby={assigneeRequired || assigneeUnavailable ? errorId : undefined}
            onChange={event => {
              const value = event.currentTarget.value;
              setAssigneeId(value === '' ? undefined : value === UNASSIGNED ? null : value.slice(USER_OPTION.length));
              clearValidation();
            }}>
            <option value="">자동 배정 규칙 따르기</option>
            <option value={UNASSIGNED}>미지정</option>
            {latest.users.map(user => <option key={user.id} value={`${USER_OPTION}${user.id}`}>{assigneeLabel(user)}</option>)}
            {assigneeUnavailable && <option value={assigneeOption} disabled>팀원 확인 불가</option>}
          </select>
        </label>
        <div className="issue-status-handoff">
          <label htmlFor={commentId}>인수인계 댓글 <span aria-hidden="true">(선택)</span></label>
          <CommentMentionInput id={commentId} className="field" rows={3} draft={comment} users={latest.users}
            readOnly={busy || recovery === 'verify' || recovery === 'verify-comment' || recovery === 'refresh'} onChange={next => {
              setComment(next);
              if (!recovery) clearValidation();
            }} />
        </div>
        {(error || stale && !busy || assigneeUnavailable) && <p id={errorId} className="issue-form-error" role="alert">
          {error || (stale ? STALE : '선택한 팀원을 찾을 수 없습니다. 담당자를 다시 선택해 주세요.')}
        </p>}
        {showDetails && !busy && <button className="btn btn-ghost issue-status-dialog-details" type="button" onClick={onOpenDetails}>업무 상세에서 확인</button>}
      </div>
      <footer>
        <button className="btn btn-ghost" type="button" onClick={close} disabled={busy}>취소</button>
        {recovery || stale ? <button ref={recoverButton} className="btn btn-primary" type="button" disabled={busy} onClick={() => void recover()}>
          {recovery === 'verify-comment' ? '저장 결과 다시 확인' : recovery === 'verify' ? '최신 상태 확인' : '최신 업무 불러오기'}
        </button> : <button className="btn btn-primary" type="submit" disabled={busy || !selected || assigneeUnavailable}>상태 변경 적용</button>}
      </footer>
    </form>
  </dialog>;
}
