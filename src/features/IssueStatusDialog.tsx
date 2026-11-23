'use client';

import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { FeatureProps, Issue, User, WorkflowStatus, WorkspaceSnapshot } from '../../shared/types';
import { projectWorkflow } from '../../shared/workflow-helpers';
import { api, ApiError, patch } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import { errorMessage } from './schedule-utils';
import './issue-status-dialog.css';

export type IssueStatusEdit = { issue: Issue; current: WorkflowStatus; choices: WorkflowStatus[]; workflowVersion: number };
type Recovery = 'conflict' | 'verify' | 'refresh';

const STALE = '업무 또는 프로젝트 워크플로가 변경되었습니다. 최신 상태를 불러온 뒤 다시 선택해 주세요.';
const REFRESH = '변경 사항을 저장했습니다. 화면에 반영하려면 최신 업무를 불러와 주세요.';
const UNASSIGNED = 'unassigned';
const USER_OPTION = 'user:';

export function IssueStatusDialog({ edit, latest, refresh, notify, onClose, onOpenDetails }: {
  edit: IssueStatusEdit;
  latest: WorkspaceSnapshot;
  refresh: FeatureProps['refresh'];
  notify: FeatureProps['notify'];
  onClose: () => void;
  onOpenDetails: () => void;
}) {
  const heading = useId();
  const errorId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const statusField = useRef<HTMLSelectElement>(null);
  const assigneeField = useRef<HTMLSelectElement>(null);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(edit.choices.length === 1 ? edit.choices[0].id : '');
  const [assigneeId, setAssigneeId] = useState<Issue['assigneeId'] | undefined>();
  const [error, setError] = useState('');
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [assigneeRequired, setAssigneeRequired] = useState(false);
  const current = latest.issues.find(issue => issue.id === edit.issue.id);
  const stale = !current || current.version !== edit.issue.version || current.projectId !== edit.issue.projectId ||
    projectWorkflow(latest, edit.issue.projectId).version !== edit.workflowVersion;
  const assigneeUnavailable = typeof assigneeId === 'string' && !latest.users.some(user => user.id === assigneeId);
  const assigneeOption = assigneeId === undefined ? '' : assigneeId === null ? UNASSIGNED : `${USER_OPTION}${assigneeId}`;
  const unknownResult = `${assigneeId === undefined ? '상태' : '상태와 담당자'} 변경 결과를 확인하지 못했습니다.`;
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
    const guard = (event: Event) => {
      if (event.defaultPrevented) return;
      if (pending.current) { event.preventDefault(); return; }
      if (recovery === 'verify' && !window.confirm(`${unknownResult} 닫을까요?`)) { event.preventDefault(); return; }
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
  }, [onClose, recovery, unknownResult]);

  function close() {
    if (!pending.current && (recovery !== 'verify' || window.confirm(`${unknownResult} 닫을까요?`))) onClose();
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

  async function committed() {
    setRecovery('refresh');
    try {
      await refresh();
      const label = edit.choices.find(status => status.id === selected)?.label ?? selected;
      notify(assigneeId === undefined ? `${edit.issue.key} · ${label}(으)로 변경했습니다.` :
        `${edit.issue.key} · 상태 ${label} · 담당자 ${assigneeName(assigneeId)} 저장 완료`);
      onClose();
    } catch { setError(REFRESH); }
  }

  async function verify() {
    let snapshot: WorkspaceSnapshot;
    try {
      snapshot = await api<WorkspaceSnapshot>('/workspace', { cache: 'no-store' });
      if (!Array.isArray(snapshot?.issues)) throw new Error(unknownResult);
    }
    catch { setRecovery('verify'); setError(`${unknownResult} 최신 업무를 확인해 주세요.`); return; }
    const confirmed = snapshot.issues.find(issue => issue.id === edit.issue.id && issue.projectId === edit.issue.projectId);
    if (matchesChange(confirmed)) { await committed(); return; }
    if (confirmed?.version === edit.issue.version && confirmed.status === edit.issue.status && confirmed.assigneeId === edit.issue.assigneeId &&
      projectWorkflow(snapshot, edit.issue.projectId).version === edit.workflowVersion) {
      setRecovery(null);
      setError('서버의 업무가 변경되지 않았습니다. 다시 적용할 수 있습니다.');
    } else {
      setRecovery('conflict');
      setError(confirmed && confirmed.version > edit.issue.version && confirmed.status === selected && assigneeId !== undefined && confirmed.assigneeId !== assigneeId
        ? '업무 상태가 바뀌었고 실제 담당자가 선택한 값과 다릅니다. 최신 업무를 확인해 주세요.' : STALE);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!selected || assigneeUnavailable || stale || recovery || pending.current) return;
    pending.current = true;
    setBusy(true);
    clearValidation();
    try {
      const updated = await patch<Issue>(`/issues/${encodeURIComponent(edit.issue.id)}`, {
        expectedVersion: edit.issue.version, expectedWorkflowVersion: edit.workflowVersion, status: selected,
        ...(assigneeId === undefined ? {} : { assigneeId }),
      });
      if (!matchesChange(updated) || updated?.version !== edit.issue.version + 1) throw new Error(unknownResult);
      await committed();
    } catch (cause) {
      if (cause instanceof ApiError && (cause.status === 409 || cause.status === 404)) { setRecovery('conflict'); setError(cause.message); }
      else if (cause instanceof ApiError && cause.status < 500 && ![408, 425, 429, 499].includes(cause.status)) {
        setError(errorMessage(cause));
        const details = cause.details;
        const requiredFields = typeof details === 'object' && details !== null && 'requiredFields' in details &&
          Array.isArray(details.requiredFields) ? details.requiredFields : [];
        const missingAssignee = cause.status === 422 && requiredFields.includes('assigneeId');
        setAssigneeRequired(missingAssignee);
        setShowDetails(cause.status === 422 && (!missingAssignee || requiredFields.length > 1));
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
        {(error || stale && !busy || assigneeUnavailable) && <p id={errorId} className="issue-form-error" role="alert">
          {error || (stale ? STALE : '선택한 팀원을 찾을 수 없습니다. 담당자를 다시 선택해 주세요.')}
        </p>}
        {showDetails && !busy && <button className="btn btn-ghost issue-status-dialog-details" type="button" onClick={onOpenDetails}>업무 상세에서 확인</button>}
      </div>
      <footer>
        <button className="btn btn-ghost" type="button" onClick={close} disabled={busy}>취소</button>
        {recovery || stale ? <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void recover()}>
          {recovery === 'verify' ? '최신 상태 확인' : '최신 업무 불러오기'}
        </button> : <button className="btn btn-primary" type="submit" disabled={busy || !selected || assigneeUnavailable}>상태 변경 적용</button>}
      </footer>
    </form>
  </dialog>;
}
