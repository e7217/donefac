'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ArrowRightLeft, RefreshCw, X } from 'lucide-react';
import type { FeatureProps, IssueBulkEditPreview, IssueBulkEditResult, ProjectWorkflow, User } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import { errorMessage } from './schedule-utils';
import './workflow-status-migration.css';

const PAGE_SIZE = 25;
type RequestKind = 'preview' | 'apply' | 'workflow' | 'refresh';

type Props = Pick<FeatureProps, 'actorId' | 'refresh' | 'notify'> & {
  savedWorkflow: ProjectWorkflow;
  users: User[];
  onClose: () => void;
};

function discardMessage(uncertain: boolean) {
  return uncertain ? '적용 결과를 아직 확인하지 못했습니다. 상태 일괄 변경을 닫을까요?' : '상태 선택과 미리보기를 버리고 닫을까요?';
}

export function WorkflowStatusMigration({ actorId, refresh, notify, savedWorkflow, users, onClose }: Props) {
  const titleId = useId();
  const descriptionId = `${titleId}-description`;
  const dialog = useRef<HTMLDialogElement>(null);
  const fromInput = useRef<HTMLSelectElement>(null);
  const request = useRef<AbortController | null>(null);
  const [workflow, setWorkflow] = useState(savedWorkflow);
  const [fromStatusId, setFromStatusId] = useState('');
  const [toStatusId, setToStatusId] = useState('');
  const [preview, setPreview] = useState<IssueBulkEditPreview | null>(null);
  const [applied, setApplied] = useState<IssueBulkEditResult | null>(null);
  const [busy, setBusy] = useState<RequestKind | null>(null);
  const [applyUncertain, setApplyUncertain] = useState(false);
  const [needsLatest, setNeedsLatest] = useState(false);
  const [error, setError] = useState('');
  const [blockedOnly, setBlockedOnly] = useState(false);
  const [page, setPage] = useState(0);
  const path = `/projects/${encodeURIComponent(workflow.projectId)}/workflow`;
  const headers = { 'X-Actor-Id': actorId };
  const dirty = !applied && Boolean(fromStatusId || toStatusId || preview || applyUncertain);

  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement;
    if (!element) return;
    element.showModal();
    fromInput.current?.focus({ preventScroll: true });
    return () => {
      request.current?.abort();
      request.current = null;
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const guard = (event: Event) => {
      if (event.defaultPrevented) return;
      if (request.current) {
        event.preventDefault();
        notify('상태 일괄 변경 요청이 끝난 뒤 이동해 주세요.', 'error');
      } else if (dirty && !window.confirm(discardMessage(applyUncertain))) event.preventDefault();
      else afterAcceptedNavigation(event, onClose);
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (!request.current && !dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('teamspace:navigate', guard);
    window.addEventListener('beforeunload', unload);
    window.addEventListener('teamspace:workspace-imported', onClose);
    return () => {
      window.removeEventListener('teamspace:navigate', guard);
      window.removeEventListener('beforeunload', unload);
      window.removeEventListener('teamspace:workspace-imported', onClose);
    };
  }, [applyUncertain, dirty, notify, onClose]);

  function close() {
    if (request.current || (dirty && !window.confirm(discardMessage(applyUncertain)))) return;
    onClose();
  }

  async function run(kind: RequestKind, action: (signal: AbortSignal) => Promise<void>) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(kind);
    setError('');
    try { await action(controller.signal); }
    catch (cause) { if (!controller.signal.aborted) setError(errorMessage(cause)); }
    finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(null);
      }
    }
  }

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!fromStatusId || !toStatusId || fromStatusId === toStatusId || needsLatest || applied || applyUncertain) return;
    void run('preview', async signal => {
      setPreview(null);
      try {
        const result = await api<IssueBulkEditPreview>(`${path}/status-migration-preview`, {
          method: 'POST', headers, signal,
          body: JSON.stringify({ fromStatusId, toStatusId, expectedWorkflowVersion: workflow.version }),
        });
        if (signal.aborted) return;
        setPreview(result);
        setBlockedOnly(false);
        setPage(0);
      } catch (cause) {
        if (!signal.aborted && cause instanceof ApiError && (cause.status === 404 || cause.status === 409)) setNeedsLatest(true);
        throw cause;
      }
    });
  }

  function apply() {
    const previewId = preview?.previewId;
    if (!previewId || preview.blocked || applied || needsLatest) return;
    void run('apply', async signal => {
      let result: IssueBulkEditResult;
      try {
        result = await api<IssueBulkEditResult>(`${path}/status-migration-apply`, {
          method: 'POST', headers, signal, body: JSON.stringify({ previewId }),
        });
      } catch (cause) {
        if (signal.aborted) return;
        if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500) {
          setApplyUncertain(false);
          setPreview(null);
          setNeedsLatest(cause.status === 409 || cause.status === 404);
          throw cause;
        }
        setApplyUncertain(true);
        throw new Error('적용 결과를 확인하지 못했습니다. 같은 미리보기로 다시 확인할 수 있습니다.');
      }
      if (signal.aborted) return;
      setApplied(result);
      setApplyUncertain(false);
      notify(`${result.updated.length}개 업무의 상태를 변경했습니다.`);
      try { await refresh(); }
      catch { if (!signal.aborted) setError('상태 이동은 저장되었습니다. 최신 업무를 다시 불러와 주세요.'); }
    });
  }

  function reloadWorkflow() {
    void run('workflow', async signal => {
      const latest = await api<ProjectWorkflow>(path, { headers, signal });
      if (signal.aborted) return;
      setWorkflow(latest);
      setFromStatusId(value => latest.statuses.some(status => status.id === value) ? value : '');
      setToStatusId(value => latest.statuses.some(status => status.id === value) ? value : '');
      setPreview(null);
      setNeedsLatest(false);
    });
  }

  const statusName = (id: string) => workflow.statuses.find(status => status.id === id)?.label ?? id;
  const userName = (id: string | null) => id ? users.find(user => user.id === id)?.name ?? id : '미지정';
  const rows = preview?.rows.filter(row => !blockedOnly || row.outcome === 'blocked') ?? [];
  const pageCount = Math.ceil(rows.length / PAGE_SIZE);
  const locked = Boolean(busy || applyUncertain || applied);
  return <dialog className="workflow-migration-dialog" ref={dialog} aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); close(); }}>
    <header>
      <h2 id={titleId}><ArrowRightLeft size={19} aria-hidden="true" />상태 일괄 변경</h2>
      <button className="btn btn-ghost" type="button" aria-label="상태 일괄 변경 닫기" onClick={close} disabled={Boolean(busy)}><X size={18} aria-hidden="true" /></button>
    </header>
    <div className="workflow-migration-body" aria-busy={Boolean(busy)}>
      <p id={descriptionId}>같은 상태의 현재 업무를 다른 상태로 옮깁니다. 저장한 도착 상태의 필수 속성을 검사하고 담당자 자동 배정을 적용합니다.</p>
      {applied ? <p role="status" className="workflow-migration-result"><strong>{applied.updated.length}개 업무의 상태를 변경했습니다.</strong></p> : <form onSubmit={review}>
        <fieldset className="workflow-migration-inputs" disabled={locked}>
          <label>출발 상태<select className="field" ref={fromInput} value={fromStatusId} onChange={event => {
            const value = event.currentTarget.value;
            setFromStatusId(value);
            if (value === toStatusId) setToStatusId('');
            setPreview(null); setError('');
          }}><option value="">상태 선택</option>{workflow.statuses.map(status => <option key={status.id} value={status.id}>{status.label}</option>)}</select></label>
          <label>도착 상태<select className="field" value={toStatusId} onChange={event => {
            setToStatusId(event.currentTarget.value); setPreview(null); setError('');
          }}><option value="">상태 선택</option>{workflow.statuses.filter(status => status.id !== fromStatusId).map(status => <option key={status.id} value={status.id}>{status.label}</option>)}</select></label>
          <button className="btn" type="submit" disabled={!fromStatusId || !toStatusId || needsLatest}>{busy === 'preview' ? '확인 중…' : '변경 미리보기'}</button>
        </fieldset>
      </form>}
      {error && <p className="issue-form-error" role="alert">{error}</p>}
      {needsLatest && !applied && <button className="btn workflow-migration-reload" type="button" onClick={reloadWorkflow} disabled={Boolean(busy)}><RefreshCw size={14} aria-hidden="true" />최신 상태 불러오기</button>}
      {applied && error && <button className="btn workflow-migration-reload" type="button" onClick={() => void run('refresh', refresh)} disabled={Boolean(busy)}><RefreshCw size={14} aria-hidden="true" />최신 업무 다시 불러오기</button>}
      {preview && !applied && <section className="workflow-migration-preview" aria-label="상태 이동 미리보기">
        <h3>{statusName(fromStatusId)} → {statusName(toStatusId)}</h3>
        <p role="status">변경 {preview.changed}개 · 차단 {preview.blocked}개</p>
        {preview.blocked > 0 && <>
          <p className="workflow-migration-blocked">차단된 업무의 사유를 해결한 뒤 다시 미리보기를 열어 주세요.</p>
          <label className="workflow-migration-filter"><input type="checkbox" checked={blockedOnly} onChange={event => { setBlockedOnly(event.currentTarget.checked); setPage(0); }} />차단된 업무만 보기</label>
        </>}
        {!preview.rows.length && <p>출발 상태에 이동할 업무가 없습니다.</p>}
        {rows.length > 0 && <ul className="workflow-migration-rows" aria-label="이동 대상 업무">
          {rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(row => <li key={row.id}>
            <div><a href={`#/${encodeURIComponent(workflow.projectId)}/issues?issue=${encodeURIComponent(row.id)}`} target="_blank" rel="noopener noreferrer" aria-label={`${row.key} 업무 새 탭에서 열기`}>{row.key}</a> <strong>{row.title}</strong></div>
            {row.reason && <p className="workflow-migration-blocked">{row.reason}</p>}
            {row.after && row.before.assigneeId !== row.after.assigneeId && <p>담당자 {userName(row.before.assigneeId)} → {userName(row.after.assigneeId)}</p>}
          </li>)}
        </ul>}
        {pageCount > 1 && <div className="workflow-migration-pagination">
          <button className="btn" type="button" disabled={page === 0} onClick={() => setPage(value => value - 1)}>이전 업무</button>
          <span aria-live="polite">{page + 1} / {pageCount}</span>
          <button className="btn" type="button" disabled={page + 1 === pageCount} onClick={() => setPage(value => value + 1)}>다음 업무</button>
        </div>}
      </section>}
    </div>
    <footer>
      <button className="btn" type="button" onClick={close} disabled={Boolean(busy)}>닫기</button>
      {preview && !applied && <button className="btn btn-primary" type="button" onClick={apply} disabled={!preview.previewId || preview.blocked > 0 || Boolean(busy) || needsLatest}>
        {busy === 'apply' ? '적용 중…' : applyUncertain ? '적용 결과 다시 확인' : '상태 이동 적용'}
      </button>}
    </footer>
  </dialog>;
}
