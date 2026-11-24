'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { DocPage, FeatureProps } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import { newRequestId } from '../lib/request-id';
import './report-meeting-draft-dialog.css';

type ReportPage = { revision: string; items: readonly unknown[] };
type Props<Report extends ReportPage> = Pick<FeatureProps, 'actorId' | 'refresh' | 'notify' | 'openDocument'> & {
  report: Report;
  initialTitle: string;
  initialDestinationId: string | null;
  destinations?: readonly { id: string | null; name: string }[];
  savePath: string;
  requestFields: (report: Report, destinationId: string | null, selectedIds?: string[]) => Record<string, unknown>;
  renderReport: (report: Report) => ReactNode;
  selectItems?: {
    legend: string;
    id: (item: Report['items'][number]) => string;
    label: (item: Report['items'][number]) => string;
    description: (item: Report['items'][number]) => string;
  };
  emptyNotice: (report: Report) => string;
  reloadReport: () => Promise<Report | null>;
  onClose: () => void;
};
type Stage =
  | { kind: 'editing' | 'stale' | 'unavailable' }
  | { kind: 'recover'; body: string }
  | { kind: 'reflect' | 'saved'; document: DocPage };
type Operation = 'save' | 'reload' | 'refresh';

const TITLE_LIMIT = 200;
const UNKNOWN = '초안 저장 결과를 확인하지 못했습니다. 같은 요청으로 결과를 다시 확인해 주세요.';
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : '요청을 처리하지 못했습니다.';

export function ReportMeetingDraftDialog<Report extends ReportPage>({ report, initialTitle, initialDestinationId, destinations, savePath,
  requestFields, renderReport, selectItems, emptyNotice, actorId, refresh, notify, openDocument, reloadReport, onClose }: Props<Report>) {
  const titleId = useId();
  const destinationNoticeId = useId();
  const itemDescriptionId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const selectAll = useRef<HTMLButtonElement>(null);
  const errorNotice = useRef<HTMLParagraphElement>(null);
  const request = useRef<AbortController | null>(null);
  const [title, setTitle] = useState(initialTitle);
  const [destinationId, setDestinationId] = useState(initialDestinationId);
  const [scope, setScope] = useState(report);
  const [selection, setSelection] = useState<Set<string> | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: 'editing' });
  const [busy, setBusy] = useState<Operation | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const trimmed = title.trim();
  const editing = stage.kind === 'editing' || stage.kind === 'stale';
  const saved = stage.kind === 'saved' ? stage.document : null;
  const needsReload = stage.kind === 'stale' || stage.kind === 'editing' && !scope.items.length;
  const titleChanged = title !== initialTitle;
  const destinationChanged = destinationId !== initialDestinationId;
  const destinationMissing = destinations?.some(destination => destination.id === destinationId) === false;
  const itemIds = selectItems ? scope.items.map(selectItems.id) : [];
  const selectedIds = selection === null ? itemIds : itemIds.filter(id => selection.has(id));
  const allSelected = selectedIds.length === itemIds.length;
  const emptySelection = Boolean(selectItems && selectedIds.length === 0);
  const selectionChanged = Boolean(selectItems && selection !== null && !allSelected);
  const dirty = editing && (titleChanged || destinationChanged || selectionChanged);

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
    return !dirty || window.confirm(destinationChanged || selectionChanged ? '회의 초안에 입력한 내용을 버릴까요?' : '입력한 회의 초안 제목을 버릴까요?');
  }, [destinationChanged, dirty, selectionChanged, stage.kind]);

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
    else if (stage.kind !== 'editing' || notice) {
      const action = primary.current?.disabled ? selectAll.current : primary.current;
      action?.focus();
    }
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
    if (stage.kind !== 'recover' && (stage.kind !== 'editing' || !trimmed || trimmed.length > TITLE_LIMIT ||
      !scope.items.length || destinationMissing || emptySelection)) return;
    void run('save', async signal => {
      const body = stage.kind === 'recover' ? stage.body : JSON.stringify({
        ...requestFields(scope, destinationId, selection === null ? undefined : selectedIds),
        requestId: newRequestId(), revision: scope.revision, title: trimmed,
      });
      let savedDocument: DocPage;
      try {
        const result = await api<{ document: DocPage; duplicate: boolean }>(savePath, {
          method: 'POST', signal, body, headers: { 'X-Actor-Id': actorId },
        });
        const document = result?.document;
        if (!document || typeof document.id !== 'string' || !document.id || typeof document.title !== 'string' ||
          document.projectId !== destinationId || typeof result.duplicate !== 'boolean') throw new Error(UNKNOWN);
        savedDocument = document;
      } catch (cause) {
        if (signal.aborted) return;
        if (cause instanceof ApiError) {
          const reason = (cause.details as { reason?: string } | undefined)?.reason;
          if (cause.status === 422 && reason === 'destination_unavailable') {
            setStage({ kind: 'editing' });
            setError(cause.message);
            return;
          }
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
        setError('최신 보고서를 불러오지 못했습니다. 입력한 내용을 유지했습니다.');
        return;
      }
      setScope(latest);
      setStage({ kind: 'editing' });
      if (selectItems && selection !== null) {
        const retained = latest.items.map(selectItems.id).filter(id => selection.has(id));
        setSelection(new Set(retained));
        const removed = selection.size - retained.length;
        if (removed > 0 && latest.items.length) {
          setNotice(`선택한 근거 중 ${removed.toLocaleString('ko-KR')}건이 현재 페이지에서 빠졌습니다. 다시 선택할 수 있습니다.`);
          return;
        }
      }
      setNotice(latest.items.length ? '최신 보고서의 범위와 업무를 확인하고 저장해 주세요.' : emptyNotice(latest));
    });
  }

  return <dialog ref={dialog} className="report-meeting-draft-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); close(); }}>
    <form onSubmit={submit}>
      <header><h2 id={titleId}>회의 초안 만들기</h2></header>
      <div className="report-meeting-draft-content">
        {saved ? <p role="status"><strong>{saved.title}</strong> 문서를 초안으로 저장했습니다.</p> : <>
          <label>회의 초안 제목
            <input className="field" ref={input} value={title} maxLength={TITLE_LIMIT} disabled={Boolean(busy)} readOnly={!editing}
              onChange={event => setTitle(event.target.value)} />
          </label>
          {destinations && <label>저장 위치
            <select className="field" value={destinationId ?? ''} disabled={Boolean(busy) || !editing}
              aria-describedby={destinationMissing && editing ? destinationNoticeId : undefined}
              onChange={event => setDestinationId(event.target.value || null)}>
              {destinationMissing && <option value={destinationId ?? ''} disabled>사용할 수 없는 저장 위치</option>}
              {destinations.map(destination => <option key={destination.id ?? ''} value={destination.id ?? ''}>{destination.name}</option>)}
            </select>
          </label>}
          {destinationMissing && editing && <p className="reports-error" role="alert" id={destinationNoticeId}>저장할 문서 공간을 다시 선택해 주세요.</p>}
          {renderReport(scope)}
          {selectItems && itemIds.length > 0 && <fieldset className="report-meeting-draft-selection" disabled={Boolean(busy) || stage.kind !== 'editing'}>
            <legend>{selectItems.legend}</legend>
            <div className="report-meeting-draft-selection-controls">
              <p role="status">{selectedIds.length.toLocaleString('ko-KR')}건 선택</p>
              <button ref={selectAll} type="button" className="btn" onClick={() => setSelection(new Set(allSelected ? [] : itemIds))}>
                {allSelected ? '선택 모두 해제' : '전체 선택'}
              </button>
            </div>
            <ul>{scope.items.map((item, index) => {
              const id = itemIds[index];
              const descriptionId = `${itemDescriptionId}-${index}`;
              return <li key={id}>
                <label><input type="checkbox" checked={selection === null || selection.has(id)} aria-describedby={descriptionId}
                  onChange={event => {
                    const next = new Set(selectedIds);
                    if (event.currentTarget.checked) next.add(id);
                    else next.delete(id);
                    setSelection(next);
                  }} />{selectItems.label(item)}</label>
                <small id={descriptionId}>{selectItems.description(item)}</small>
              </li>;
            })}</ul>
          </fieldset>}
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
            disabled={Boolean(busy) || !trimmed || trimmed.length > TITLE_LIMIT || (stage.kind !== 'recover' && (destinationMissing || emptySelection))}>
            {stage.kind === 'recover' ? '초안 저장 결과 다시 확인' : '회의 초안 저장'}
          </button>}
      </footer>
    </form>
  </dialog>;
}
