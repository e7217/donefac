'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { DeliveryBlockerDraftResult, DeliveryBlockerReport, DocPage, FeatureProps } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import { newRequestId } from '../lib/request-id';

type Props = Pick<FeatureProps, 'actorId' | 'refresh' | 'notify' | 'openDocument'> & {
  report: DeliveryBlockerReport;
  reasonLabel: string;
  reloadReport: () => Promise<DeliveryBlockerReport | null>;
  onClose: () => void;
};
type Stage =
  | { kind: 'editing' | 'stale' | 'unavailable' }
  | { kind: 'recover'; body: string }
  | { kind: 'reflect' | 'saved'; document: DocPage };
type Operation = 'save' | 'reload' | 'refresh';

const TITLE_LIMIT = 200;
const ROW_LIMIT = 20;
const UNKNOWN = '초안 저장 결과를 확인하지 못했습니다. 같은 요청으로 결과를 다시 확인해 주세요.';
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : '요청을 처리하지 못했습니다.';

export function DeliveryBlockerMeetingDraftDialog({ report, reasonLabel, actorId, refresh, notify, openDocument, reloadReport, onClose }: Props) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const errorNotice = useRef<HTMLParagraphElement>(null);
  const request = useRef<AbortController | null>(null);
  const [initialTitle] = useState(() => `${report.release ? '릴리스 준비 회의' : '진행 차단 회의'} · ${report.generatedAt.slice(0, 10)}`);
  const [title, setTitle] = useState(initialTitle);
  const [scope, setScope] = useState(report);
  const [stage, setStage] = useState<Stage>({ kind: 'editing' });
  const [busy, setBusy] = useState<Operation | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const trimmed = title.trim();
  const editing = stage.kind === 'editing' || stage.kind === 'stale';
  const saved = stage.kind === 'saved' ? stage.document : null;
  const needsReload = stage.kind === 'stale' || stage.kind === 'editing' && !scope.total;
  const draftCount = Math.min(scope.total, ROW_LIMIT);
  const dirty = editing && title !== initialTitle;

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const opener = document.activeElement;
    element.showModal();
    input.current?.focus({ preventScroll: true });
    return () => {
      request.current?.abort();
      request.current = null;
      element.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  const canDiscard = useCallback(() => {
    if (stage.kind === 'recover') return window.confirm('초안이 저장됐을 수 있습니다. 새 초안을 만들기 전에 문서 목록에서 결과를 확인해 주세요. 계속할까요?');
    return !dirty || window.confirm('입력한 회의 초안 제목을 버릴까요?');
  }, [dirty, stage.kind]);

  useEffect(() => {
    function guard(event: Event) {
      if (event.defaultPrevented) return;
      if (request.current) {
        event.preventDefault();
        notify('회의 초안 요청이 끝난 뒤 이동해 주세요.', 'error');
      } else if (canDiscard()) {
        afterAcceptedNavigation(event, onClose);
      } else {
        event.preventDefault();
      }
    }
    function unload(event: BeforeUnloadEvent) {
      if (!request.current && !dirty && stage.kind !== 'recover') return;
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('teamspace:navigate', guard);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('teamspace:navigate', guard);
      window.removeEventListener('beforeunload', unload);
    };
  }, [canDiscard, dirty, notify, onClose, stage.kind]);

  useEffect(() => {
    if (busy) return;
    if (stage.kind === 'unavailable') errorNotice.current?.focus();
    else if (stage.kind !== 'editing' || notice) primary.current?.focus();
  }, [busy, notice, stage.kind]);

  function close() {
    if (request.current || !canDiscard()) return;
    onClose();
  }

  async function run(operation: Operation, perform: (signal: AbortSignal) => Promise<void>) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(operation);
    setError('');
    setNotice('');
    try {
      await perform(controller.signal);
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(null);
      }
    }
  }

  async function reflect(document: DocPage, signal: AbortSignal) {
    if (signal.aborted) return;
    try {
      await refresh();
    } catch {
      if (!signal.aborted) {
        setStage({ kind: 'reflect', document });
        setError('회의 초안을 저장했습니다. 문서 목록을 다시 불러온 뒤 열 수 있습니다.');
      }
      return;
    }
    if (!signal.aborted) setStage({ kind: 'saved', document });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (stage.kind !== 'recover' && (stage.kind !== 'editing' || !trimmed || trimmed.length > TITLE_LIMIT || !scope.total)) return;
    void run('save', async signal => {
      const body = stage.kind === 'recover' ? stage.body : JSON.stringify({
        requestId: newRequestId(), revision: scope.revision, title: trimmed,
        ...(scope.savedView ? { savedViewId: scope.savedView.id } : {}),
        ...(scope.reason ? { reason: scope.reason } : {}),
        ...(scope.release ? { releaseId: scope.release.id } : {}),
      });
      let savedDocument: DocPage;
      try {
        const result = await api<DeliveryBlockerDraftResult>(`/projects/${encodeURIComponent(scope.projectId)}/delivery-blockers/meeting-draft`, {
          method: 'POST', signal, body, headers: { 'X-Actor-Id': actorId },
        });
        const document = result?.document;
        if (!document || typeof document.id !== 'string' || !document.id || typeof document.title !== 'string' ||
          document.projectId !== scope.projectId || typeof result.duplicate !== 'boolean') throw new Error(UNKNOWN);
        savedDocument = document;
      } catch (cause) {
        if (signal.aborted) return;
        if (cause instanceof ApiError) {
          const reason = (cause.details as { reason?: string } | undefined)?.reason;
          if ((cause.status === 409 && reason === 'stale_report') || (cause.status === 404 && stage.kind !== 'recover')) {
            setStage({ kind: 'stale' });
            setError('보고서가 바뀌었습니다. 최신 보고서를 불러와 회의에 담을 업무를 확인해 주세요.');
            return;
          }
          if (cause.status === 409 && (reason === 'result_unavailable' || reason === 'request_conflict')) {
            setStage({ kind: 'unavailable' });
            setError(cause.message);
            return;
          }
          if (stage.kind !== 'recover' && [400, 401, 403, 413, 422].includes(cause.status)) {
            setError(cause.message);
            return;
          }
        }
        setStage({ kind: 'recover', body });
        setError(UNKNOWN);
        return;
      }
      await reflect(savedDocument, signal);
    });
  }

  function reload() {
    void run('reload', async signal => {
      const latest = await reloadReport();
      if (signal.aborted) return;
      if (!latest) {
        setError('최신 보고서를 불러오지 못했습니다. 제목을 유지했습니다.');
        return;
      }
      setScope(latest);
      setStage({ kind: 'editing' });
      setNotice(latest.total ? '최신 보고서의 범위와 업무를 확인하고 저장해 주세요.'
        : latest.release ? '이 조건에서 준비를 확인할 업무가 없습니다.' : '이 조건에 해당하는 차단 업무가 없습니다.');
    });
  }

  return <dialog ref={dialog} className="delivery-blocker-draft-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); close(); }}>
    <form onSubmit={submit}>
      <header><h2 id={titleId}>회의 초안 만들기</h2></header>
      <div className="delivery-blocker-draft-content">
        {saved ? <p role="status"><strong>{saved.title}</strong> 문서를 초안으로 저장했습니다.</p> : <>
          <label>회의 초안 제목
            <input className="field" ref={input} value={title} maxLength={TITLE_LIMIT} disabled={Boolean(busy)} readOnly={!editing}
              onChange={event => setTitle(event.target.value)} />
          </label>
          <dl aria-label="회의 초안 조건">
            {scope.release && <>
              <div><dt>릴리스</dt><dd>{scope.release.name}</dd></div>
              <div><dt>{scope.release.deadlineSource === 'endDate' ? '릴리스 종료일' : scope.release.deadline ? '릴리스 목표일' : '릴리스 기한'}</dt>
                <dd>{scope.release.deadline ? <time dateTime={scope.release.deadline}>{scope.release.deadline}</time> : '미정'}</dd>
              </div>
            </>}
            <div><dt>공유 보기</dt><dd>{scope.savedView?.name ?? '프로젝트 전체'}</dd></div>
            <div><dt>차단 원인</dt><dd>{reasonLabel}</dd></div>
            <div><dt>대상 업무</dt><dd>{scope.total.toLocaleString('ko-KR')}개</dd></div>
          </dl>
          {scope.total > 0 && <p>보고서 순서대로 최대 {ROW_LIMIT}개 업무를 문서에 담습니다.</p>}
          {draftCount > 0 && <details>
            <summary>요약에 포함할 업무 {draftCount}개</summary>
            <ol>{scope.items.slice(0, ROW_LIMIT).map(row => <li key={row.issue.id}>
              <strong>{row.issue.key} · {row.issue.title}</strong>
              <p>{[
                row.blockers.total ? `수동 차단 ${row.blockers.total}건` : '',
                row.scheduleConflicts.total ? `간트 일정 충돌 ${row.scheduleConflicts.total}건` : '',
                row.gitlab.blockedMergeRequests ? `병합 확인이 필요한 MR ${row.gitlab.blockedMergeRequests}건` : '',
                row.gitlab.failedPipelines ? `실패한 파이프라인 ${row.gitlab.failedPipelines}건` : '',
                row.releaseSchedule?.missing.includes('startDate') ? '시작일 미정' : '',
                row.releaseSchedule?.missing.includes('endDate') ? '종료일 미정' : '',
                row.releaseSchedule?.afterDeadline ? `릴리스 기한 초과 · 종료일 ${row.releaseSchedule.endDate}` : '',
              ].filter(Boolean).join(' · ')}</p>
            </li>)}</ol>
          </details>}
        </>}
        {busy && <p role="status">{busy === 'save' ? '회의 초안을 확인하는 중입니다.' : '최신 목록을 불러오는 중입니다.'}</p>}
        {error && <p className="reports-error" role="alert" tabIndex={-1} ref={errorNotice}>{error}</p>}
        {notice && <p role="status">{notice}</p>}
      </div>
      <footer>
        <button type="button" className="btn btn-ghost" disabled={Boolean(busy)} onClick={close}>닫기</button>
        {saved ? <button ref={primary} type="button" className="btn btn-primary" onClick={() => openDocument(saved.id)}>문서 열기</button>
          : stage.kind === 'reflect' ? <button ref={primary} type="button" className="btn btn-primary" disabled={Boolean(busy)}
            onClick={() => void run('refresh', signal => reflect(stage.document, signal))}>문서 목록 다시 불러오기</button>
          : needsReload ? <button ref={primary} type="button" className="btn btn-primary" disabled={Boolean(busy)} onClick={reload}>최신 보고서 불러오기</button>
          : stage.kind !== 'unavailable' && <button ref={primary} type="submit" className="btn btn-primary"
            disabled={Boolean(busy) || !trimmed || trimmed.length > TITLE_LIMIT}>{stage.kind === 'recover' ? '초안 저장 결과 다시 확인' : '회의 초안 저장'}</button>}
      </footer>
    </form>
  </dialog>;
}
