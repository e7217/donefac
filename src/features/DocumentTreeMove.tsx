'use client';

import { X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import type { DocPage, DocumentTreeMovePreview, Project } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';

interface Props {
  document: DocPage;
  documents: DocPage[];
  projects: Project[];
  refreshWorkspace?: () => Promise<void>;
  onClose: () => void;
  onMoved: () => void;
  beforeApply?: () => string | null;
}

type RequestKind = 'preview' | 'apply';
const PREVIEW_PAGE_SIZE = 50;

function subtreeIds(rootId: string, documents: DocPage[]) {
  const children = new Map<string, string[]>();
  for (const page of documents) {
    if (page.parentId === null) continue;
    const siblings = children.get(page.parentId);
    if (siblings) siblings.push(page.id);
    else children.set(page.parentId, [page.id]);
  }
  const ids = new Set([rootId]);
  for (const id of ids) {
    for (const childId of children.get(id) ?? []) ids.add(childId);
  }
  return ids;
}

export function DocumentTreeMove({
  document: page, documents, projects, refreshWorkspace, onClose, onMoved, beforeApply,
}: Props) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const spaceInput = useRef<HTMLSelectElement>(null);
  const pending = useRef<AbortController | null>(null);
  const [projectId, setProjectId] = useState(page.projectId);
  const [parentId, setParentId] = useState(page.parentId);
  const [preview, setPreview] = useState<DocumentTreeMovePreview | null>(null);
  const [previewPage, setPreviewPage] = useState(0);
  const [busy, setBusy] = useState<RequestKind | null>(null);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const subtree = useMemo(() => subtreeIds(page.id, documents), [page.id, documents]);
  const parents = documents.filter(document => document.projectId === projectId && !subtree.has(document.id));
  const projectUnavailable = projectId !== null && !projects.some(project => project.id === projectId);
  const parentUnavailable = parentId !== null && !parents.some(parent => parent.id === parentId);
  const pageCount = Math.ceil((preview?.documents.length ?? 0) / PREVIEW_PAGE_SIZE);
  const dirty = Boolean(preview?.changed || uncertain || projectId !== page.projectId || parentId !== page.parentId);
  const discardMessage = uncertain
    ? '문서 이동 결과를 아직 확인하지 못했습니다. 창을 닫을까요?'
    : '선택한 위치와 이동 미리보기를 버리고 닫을까요?';
  const path = `/documents/${encodeURIComponent(page.id)}`;

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const opener = document.activeElement;
    element.showModal();
    spaceInput.current?.focus({ preventScroll: true });
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
      if (pending.current || (dirty && !window.confirm(discardMessage))) event.preventDefault();
      else afterAcceptedNavigation(event, onClose);
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (!pending.current && !dirty) return;
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
  }, [dirty, discardMessage, onClose]);

  function close() {
    if (pending.current || (dirty && !window.confirm(discardMessage))) return;
    onClose();
  }

  async function run(kind: RequestKind, token?: string) {
    if (pending.current || projectUnavailable || parentUnavailable) return;
    if (kind === 'apply') {
      const reason = beforeApply?.();
      if (reason) { setError(reason); return; }
    }
    const controller = new AbortController();
    pending.current = controller;
    setBusy(kind);
    setError('');
    if (kind === 'preview') {
      setPreview(null);
      setPreviewPage(0);
    }
    let moved = false;
    try {
      const result = await api<DocumentTreeMovePreview>(`${path}/${kind === 'preview' ? 'move-preview' : 'move'}`, {
        method: 'POST', signal: controller.signal, body: JSON.stringify({ projectId, parentId, token }),
      });
      if (controller.signal.aborted) return;
      setUncertain(false);
      if (kind === 'preview') {
        setPreview(result);
        if (!result.changed && (uncertain || page.projectId !== result.sourceProjectId || page.parentId !== result.sourceParentId)) {
          try { await refreshWorkspace?.(); }
          catch {
            if (!controller.signal.aborted) setError('현재 위치를 확인했습니다. 작업 공간을 새로고침해 최신 문서 목록을 확인해 주세요.');
          }
        }
      } else moved = true;
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && (cause.status === 409 || cause.status === 404)) {
        setPreview(null);
        setUncertain(false);
        setError('문서 또는 이동 위치가 변경되었습니다. 이동 미리보기를 다시 확인해 주세요.');
        try { await refreshWorkspace?.(); }
        catch {
          if (!controller.signal.aborted) setError('최신 문서 위치를 불러오지 못했습니다. 이동 미리보기를 다시 확인해 주세요.');
        }
      } else if (kind === 'apply' && (!(cause instanceof ApiError) || cause.status >= 500)) {
        setPreview(null);
        setUncertain(true);
        setError('이동 결과를 확인하지 못했습니다. 현재 위치를 확인하려면 이동 미리보기를 다시 실행해 주세요.');
      } else {
        setError(cause instanceof Error ? cause.message : '문서 이동 요청을 처리하지 못했습니다.');
      }
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(null);
      }
    }
    if (moved) onMoved();
  }

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run('preview');
  }

  function discardPreview() {
    setPreview(null);
    setError('');
    setUncertain(false);
  }

  function locationName(spaceId: string | null, containerId: string | null) {
    const space = spaceId === null ? '팀 공통 문서' : projects.find(project => project.id === spaceId)?.name ?? '프로젝트';
    const parent = containerId === null ? '최상위 문서' : documents.find(document => document.id === containerId)?.title || '상위 문서';
    return `${space} / ${parent}`;
  }

  return <dialog ref={dialog} className="docs-move-dialog" aria-labelledby={titleId}
    aria-busy={Boolean(busy)} onCancel={event => { event.preventDefault(); close(); }}>
    <header className="docs-modal-header">
      <h2 id={titleId}>문서 이동</h2>
      <button className="btn btn-ghost docs-icon-button" type="button" aria-label="문서 이동 닫기" disabled={Boolean(busy)} onClick={close}>
        <X size={18} aria-hidden="true" />
      </button>
    </header>
    <form className="docs-move-body" onSubmit={review}>
      <p><strong>{page.title || '제목 없는 문서'}</strong>의 새 위치를 선택하세요.</p>
      <fieldset className="docs-move-fields" disabled={Boolean(busy)}>
        <label className="docs-modal-label">이동할 공간
          <select className="field" ref={spaceInput} value={projectId ?? ''} onChange={event => {
            setProjectId(event.currentTarget.value || null);
            setParentId(null);
            discardPreview();
          }}>
            <option value="">팀 공통 문서</option>
            {projectUnavailable && <option value={projectId ?? ''} disabled>선택한 공간을 찾을 수 없음</option>}
            {projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}
          </select>
        </label>
        <label className="docs-modal-label">이동할 상위 문서
          <select className="field" value={parentId ?? ''} onChange={event => {
            setParentId(event.currentTarget.value || null);
            discardPreview();
          }}>
            <option value="">최상위 문서</option>
            {parentUnavailable && <option value={parentId ?? ''} disabled>선택한 상위 문서를 찾을 수 없음</option>}
            {parents.map(parent => <option key={parent.id} value={parent.id}>{parent.title || '제목 없는 문서'}</option>)}
          </select>
        </label>
        <button type="submit" className="btn" disabled={projectUnavailable || parentUnavailable}>
          {busy === 'preview' ? '미리보기 확인 중…' : '이동 미리보기'}
        </button>
      </fieldset>
      {error && <p className="issue-form-error" role="alert">{error}</p>}
      {preview && <section className="docs-move-preview" aria-label="이동 대상 문서">
        {!preview.changed ? <p role="status">선택한 위치가 현재 문서 위치와 같습니다.</p> : <>
          <h3>{locationName(preview.sourceProjectId, preview.sourceParentId)} → {locationName(preview.projectId, preview.parentId)}</h3>
          <p role="status"><strong>문서 {preview.documents.length}개를 이동합니다.</strong> 하위 문서의 계층은 유지됩니다.</p>
          <ul className="docs-move-list">
            {preview.documents.slice(previewPage * PREVIEW_PAGE_SIZE, (previewPage + 1) * PREVIEW_PAGE_SIZE)
              .map(document => <li key={document.id}>{document.title || '제목 없는 문서'}</li>)}
          </ul>
          {pageCount > 1 && <div className="docs-move-pagination">
            <button className="btn" type="button" disabled={previewPage === 0 || Boolean(busy)} onClick={() => setPreviewPage(value => value - 1)}>이전 문서 목록</button>
            <span aria-live="polite">{previewPage + 1} / {pageCount}</span>
            <button className="btn" type="button" disabled={previewPage + 1 === pageCount || Boolean(busy)} onClick={() => setPreviewPage(value => value + 1)}>다음 문서 목록</button>
          </div>}
          {preview.sourceProjectId !== preview.projectId && preview.archivedCount > 0 &&
            <p>휴지통 문서 {preview.archivedCount}개는 복원할 때 현재 상위 문서의 위치를 따릅니다.</p>}
        </>}
      </section>}
    </form>
    <footer className="docs-modal-footer">
      <button className="btn btn-ghost" type="button" disabled={Boolean(busy)} onClick={close}>취소</button>
      <button className="btn btn-primary" type="button" disabled={Boolean(busy) || !preview?.changed || projectUnavailable || parentUnavailable}
        onClick={() => { if (preview?.changed) void run('apply', preview.token); }}>
        {busy === 'apply' ? '문서 이동 중…' : '문서 이동 적용'}
      </button>
    </footer>
  </dialog>;
}
