'use client';

import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DocPage, DocumentSiblingOrder, Project } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import { reorderDocumentPlacement, type DocumentOrderPlacement } from './document-tree-drag';
import './document-sibling-order.css';

interface Props {
  documentId: string;
  documents: readonly DocPage[];
  projects: readonly Project[];
  placement?: DocumentOrderPlacement;
  refreshWorkspace: () => Promise<void>;
  onClose: () => void;
}

type RequestKind = 'load' | 'save' | 'verify';
type Feedback = { kind: 'status' | 'error' | 'conflict' | 'uncertain'; message: string };

const DISCARD = '편집 중인 문서 순서를 버릴까요?';
const CONFLICT = '다른 작업자가 문서 순서나 위치를 변경했습니다. 최신 순서를 불러온 뒤 다시 편집해 주세요.';
const UNCERTAIN = '문서 순서 저장 결과를 확인하지 못했습니다. 편집한 순서는 유지했습니다.';
const SAVED = '문서 순서를 저장했습니다.';

function sameIds(first: readonly string[], second: readonly string[]) {
  return first.length === second.length && first.every((id, index) => id === second[index]);
}

export function DocumentSiblingOrderDialog({ documentId, documents, projects, placement, refreshWorkspace, onClose }: Props) {
  const headingId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const updatedDocumentFocus = useRef<HTMLButtonElement | null>(null);
  const pending = useRef<AbortController | null>(null);
  const [baseline, setBaseline] = useState<DocumentSiblingOrder | null>(null);
  const [draft, setDraft] = useState<string[]>([]);
  const [busy, setBusy] = useState<RequestKind | null>('load');
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const pages = useMemo(() => new Map(documents.map(page => [page.id, page])), [documents]);
  const dirty = Boolean(baseline && !sameIds(baseline.documentIds, draft));
  const blocked = feedback?.kind === 'conflict' || feedback?.kind === 'uncertain';
  const savingLost = feedback?.kind === 'uncertain';
  const path = `/documents/${encodeURIComponent(documentId)}/sibling-order`;

  const requestOrder = useCallback(async (signal: AbortSignal, previous?: DocumentSiblingOrder, nextIds?: string[]) => {
    const order = await api<DocumentSiblingOrder>(path, previous
      ? { method: 'PATCH', signal, body: JSON.stringify({ expectedVersion: previous.version, documentIds: nextIds }) }
      : { signal, cache: 'no-store' });
    if (!order || typeof order.version !== 'string' || !Array.isArray(order.documentIds) || !order.documentIds.includes(documentId)) {
      throw new Error('문서 순서를 확인하지 못했습니다.');
    }
    return order;
  }, [documentId, path]);

  const adopt = useCallback((order: DocumentSiblingOrder) => {
    setBaseline(order);
    setDraft(order.documentIds);
  }, []);

  const begin = useCallback((kind: RequestKind) => {
    const controller = new AbortController();
    pending.current = controller;
    setBusy(kind);
    return controller;
  }, []);

  const end = useCallback((controller: AbortController) => {
    if (pending.current !== controller) return;
    pending.current = null;
    setBusy(null);
  }, []);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const opener = window.document.activeElement;
    element.showModal();
    heading.current?.focus({ preventScroll: true });
    return () => {
      pending.current?.abort();
      pending.current = null;
      element.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const guard = (event: Event) => {
      if (event.defaultPrevented) return;
      if (pending.current || (dirty && !window.confirm(DISCARD))) event.preventDefault();
      else afterAcceptedNavigation(event, onClose);
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (!pending.current && !dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('donefac:navigate', guard);
    window.addEventListener('beforeunload', unload);
    window.addEventListener('donefac:workspace-imported', onClose);
    return () => {
      window.removeEventListener('donefac:navigate', guard);
      window.removeEventListener('beforeunload', unload);
      window.removeEventListener('donefac:workspace-imported', onClose);
    };
  }, [dirty, onClose]);

  useEffect(() => {
    const controller = new AbortController();
    pending.current = controller;
    void requestOrder(controller.signal).then(async order => {
      if (controller.signal.aborted) return;
      adopt(order);
      if (placement) {
        const proposed = reorderDocumentPlacement(order, documentId, placement);
        if (proposed) setDraft(proposed);
        else setFeedback({ kind: 'conflict', message: CONFLICT });
      }
      try {
        await refreshWorkspace();
      } catch {
        if (!controller.signal.aborted) setFeedback(previous => previous?.kind === 'conflict' ? previous :
          { kind: 'error', message: '최신 문서 제목을 불러오지 못했습니다.' });
      }
    }).catch(cause => {
      if (!controller.signal.aborted) setFeedback({ kind: 'error', message: cause instanceof Error ? cause.message : '문서 순서를 불러오지 못했습니다.' });
    }).finally(() => end(controller));
    return () => controller.abort();
  }, [adopt, documentId, end, placement, requestOrder, refreshWorkspace]);

  useLayoutEffect(() => {
    const control = updatedDocumentFocus.current;
    updatedDocumentFocus.current = null;
    if (!control?.isConnected) return;
    control.focus({ preventScroll: true });
    control.scrollIntoView({ block: 'nearest' });
  }, [draft]);

  function close() {
    if (!pending.current && (!dirty || window.confirm(DISCARD))) onClose();
  }

  function move(index: number, offset: number, control: HTMLButtonElement) {
    const next = index + offset;
    if (pending.current || blocked || next < 0 || next >= draft.length) return;
    updatedDocumentFocus.current = control;
    const reordered = [...draft];
    [reordered[index], reordered[next]] = [reordered[next], reordered[index]];
    setDraft(reordered);
    setFeedback(null);
  }

  async function reload() {
    if (pending.current || (dirty && !window.confirm('편집 중인 문서 순서를 버리고 최신 순서를 불러올까요?'))) return;
    const controller = begin('load');
    try {
      const order = await requestOrder(controller.signal);
      if (controller.signal.aborted) return;
      await refreshWorkspace();
      if (controller.signal.aborted) return;
      adopt(order);
      setFeedback({ kind: 'status', message: '최신 문서 순서를 불러왔습니다.' });
    } catch (cause) {
      if (!controller.signal.aborted) setFeedback({ kind: blocked ? feedback.kind : 'error',
        message: cause instanceof Error ? cause.message : '최신 문서 순서를 불러오지 못했습니다.' });
    } finally { end(controller); }
  }

  async function saved(order: DocumentSiblingOrder, controller: AbortController) {
    adopt(order);
    setFeedback({ kind: 'status', message: SAVED });
    try {
      await refreshWorkspace();
    } catch {
      if (!controller.signal.aborted) setFeedback({ kind: 'error', message: `${SAVED} 문서 트리를 갱신하려면 최신 순서를 불러와 주세요.` });
    }
  }

  async function verify(controller: AbortController, previous: DocumentSiblingOrder, nextIds: string[]) {
    try {
      const current = await requestOrder(controller.signal);
      if (controller.signal.aborted) return;
      if (current.projectId === previous.projectId && current.parentId === previous.parentId && sameIds(current.documentIds, nextIds)) {
        await saved(current, controller);
      } else if (current.version === previous.version) {
        setFeedback({ kind: 'error', message: '서버의 문서 순서는 그대로입니다. 저장을 다시 시도할 수 있습니다.' });
      } else setFeedback({ kind: 'conflict', message: CONFLICT });
    } catch (cause) {
      if (controller.signal.aborted) return;
      const gone = cause instanceof ApiError && cause.status === 404;
      setFeedback({ kind: gone ? 'conflict' : 'uncertain', message: gone ? CONFLICT : UNCERTAIN });
    }
  }

  async function save() {
    if (!baseline || pending.current || !dirty || blocked) return;
    const controller = begin('save');
    setFeedback(null);
    try {
      const ordered = await requestOrder(controller.signal, baseline, draft);
      if (controller.signal.aborted) return;
      if (ordered.projectId !== baseline.projectId || ordered.parentId !== baseline.parentId || !sameIds(ordered.documentIds, draft)) throw new Error(UNCERTAIN);
      await saved(ordered, controller);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && (cause.status === 409 || cause.status === 404)) setFeedback({ kind: 'conflict', message: CONFLICT });
      else if (cause instanceof ApiError && cause.status < 500 && ![408, 425, 429, 499].includes(cause.status)) {
        setFeedback({ kind: 'error', message: cause.message });
      } else await verify(controller, baseline, draft);
    } finally { end(controller); }
  }

  async function verifySave() {
    if (!baseline || pending.current || !savingLost) return;
    const controller = begin('verify');
    try { await verify(controller, baseline, draft); }
    finally { end(controller); }
  }

  const space = baseline?.projectId ? projects.find(project => project.id === baseline.projectId)?.name ?? '프로젝트 문서' : '팀 공통 문서';
  const parent = baseline?.parentId ? pages.get(baseline.parentId)?.title ?? '상위 문서' : '최상위 문서';

  return <dialog ref={dialog} className="docs-move-dialog docs-sibling-order-dialog" aria-labelledby={headingId} aria-busy={busy !== null}
    onCancel={event => { event.preventDefault(); close(); }}>
    <header>
      <h2 ref={heading} id={headingId} tabIndex={-1}>문서 순서 편집</h2>
      <button className="btn btn-ghost docs-icon-button" type="button" aria-label="문서 순서 편집 닫기" disabled={busy !== null} onClick={close}>
        <X size={18} aria-hidden="true" />
      </button>
    </header>
    <div className="docs-move-body">
      {!baseline && busy === 'load' && <p role="status">문서 순서를 불러오는 중입니다.</p>}
      {feedback && <p className={feedback.kind === 'status' ? undefined : 'issue-form-error'}
        role={feedback.kind === 'status' ? 'status' : 'alert'}>{feedback.message}</p>}
      {baseline && <>
        <p className="docs-sibling-order-position"><strong>{space}</strong> / {parent}</p>
        {draft.length === 1 && <p>같은 위치에 다른 문서가 없습니다.</p>}
        <ol className="docs-sibling-order-list" role="list" aria-label="같은 위치의 문서">
          {draft.map((id, index) => {
            const page = pages.get(id);
            const title = page?.title || '제목을 확인할 수 없는 문서';
            return <li key={id} data-document-id={id}>
              <span className="docs-sibling-order-title" aria-current={id === documentId ? placement ? 'true' : 'page' : undefined}>
                <strong>{title}</strong>{id === documentId && <small>{placement ? '선택한 문서' : '현재 문서'}</small>}
              </span>
              <div className="docs-sibling-order-arrows">
                <button type="button" className="btn btn-ghost docs-icon-button" aria-label={`${title} 위로 이동`}
                  aria-disabled={busy !== null || blocked || index === 0} onClick={event => move(index, -1, event.currentTarget)}><ArrowUp size={16} aria-hidden="true" /></button>
                <button type="button" className="btn btn-ghost docs-icon-button" aria-label={`${title} 아래로 이동`}
                  aria-disabled={busy !== null || blocked || index === draft.length - 1} onClick={event => move(index, 1, event.currentTarget)}><ArrowDown size={16} aria-hidden="true" /></button>
              </div>
            </li>;
          })}
        </ol>
      </>}
    </div>
    <footer>
      <button className="btn btn-ghost" type="button" disabled={busy !== null} onClick={close}>취소</button>
      <button className="btn" type="button" disabled={busy !== null} onClick={() => void reload()}>최신 순서 불러오기</button>
      {savingLost ? <button className="btn btn-primary" type="button" disabled={busy !== null} onClick={() => void verifySave()}>저장 결과 확인</button> :
        <button className="btn btn-primary" type="button" disabled={busy !== null || !dirty || blocked} onClick={() => void save()}>
          {busy === 'save' ? '문서 순서 저장 중…' : '문서 순서 저장'}
        </button>}
    </footer>
  </dialog>;
}
