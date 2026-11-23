'use client';

import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { FeatureProps, Issue, WorkflowStatus, WorkspaceSnapshot } from '../../shared/types';
import { projectWorkflow } from '../../shared/workflow-helpers';
import { api, ApiError, patch } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import { errorMessage } from './schedule-utils';
import './issue-status-dialog.css';

export type IssueStatusEdit = { issue: Issue; current: WorkflowStatus; choices: WorkflowStatus[]; workflowVersion: number };
type Recovery = 'conflict' | 'verify' | 'refresh';

const STALE = '업무 또는 프로젝트 워크플로가 변경되었습니다. 최신 상태를 불러온 뒤 다시 선택해 주세요.';
const UNKNOWN = '상태 변경 결과를 확인하지 못했습니다. 최신 상태를 확인해 주세요.';
const REFRESH = '상태를 저장했습니다. 보드에 반영하려면 최신 업무를 불러와 주세요.';

export function IssueStatusDialog({ edit, latest, refresh, notify, onClose, onOpenDetails }: {
  edit: IssueStatusEdit;
  latest: WorkspaceSnapshot;
  refresh: FeatureProps['refresh'];
  notify: FeatureProps['notify'];
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

  return <dialog ref={dialog} className="issue-status-dialog" aria-labelledby={heading} aria-busy={busy}
    onCancel={event => { event.preventDefault(); close(); }}>
    <form onSubmit={event => void submit(event)}>
      <header><h2 id={heading}>업무 상태 변경</h2>
        <button className="btn btn-ghost issue-icon-button" type="button" aria-label="상태 변경 닫기" disabled={busy} onClick={close}><X size={17} aria-hidden="true" /></button>
      </header>
      <div className="issue-status-dialog-body">
        <p><strong>{edit.issue.key}</strong> · {edit.issue.title}</p>
        <p>현재 상태 <span aria-hidden="true" className="issue-status-dot" style={{ background: edit.current.color }} />{edit.current.label}</p>
        <label>변경할 상태
          <select ref={statusField} className="field" value={selected} required disabled={busy || stale || Boolean(recovery)}
            onChange={event => { setSelected(event.currentTarget.value); setError(''); setRejected(false); }}>
            <option value="" disabled>상태 선택</option>
            {edit.choices.map(status => <option key={status.id} value={status.id}>{status.label}</option>)}
          </select>
        </label>
        {(error || stale && !busy) && <p className="issue-form-error" role="alert">{error || STALE}</p>}
        {rejected && !busy && <button className="btn btn-ghost issue-status-dialog-details" type="button" onClick={onOpenDetails}>업무 상세에서 확인</button>}
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
