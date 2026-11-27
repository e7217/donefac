'use client';

import { X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import type { DocPage, DocumentTreeCopyOptions, DocumentTreeCopyPreview, Project } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import { newRequestId } from '../lib/request-id';
import { isDefiniteTemplateFailure, templateErrorReason } from './DocumentTemplates';
import { documentDestinationLabel, documentParentLabels } from './document-utils';
import './document-tree-copy.css';

interface Props {
  source: DocPage;
  documents: readonly DocPage[];
  projects: readonly Project[];
  actorId: string;
  refreshWorkspace: () => Promise<void>;
  onClose: () => void;
  onOpenCopy: (id: string) => boolean;
}

type CopyFields = Omit<DocumentTreeCopyOptions, 'expectedSourceVersion'>;
type CopyRequest = { actorId: string; body: string; projectId: string | null };
type Task = 'preview' | 'apply' | 'refresh';

const PAGE_SIZE = 12;
const TITLE_LIMIT = 300;
const STALE = '원본 문서, 하위 문서 또는 복제 위치가 변경되었습니다. 복제 미리보기를 다시 확인해 주세요.';
const UNCONFIRMED = '복제 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인해 주세요.';
const LOST_RECEIPT = '복제 결과를 열 수 없습니다. 문서 목록과 휴지통을 확인해 주세요.';

function initialFields(source: DocPage): CopyFields {
  const suffix = ' 사본';
  return { title: `${source.title.slice(0, TITLE_LIMIT - suffix.length).replace(/[\uD800-\uDBFF]$/u, '')}${suffix}`,
    projectId: source.projectId, parentId: source.parentId, includeDescendants: false };
}

function requestError(cause: unknown) {
  return cause instanceof Error ? cause.message : '문서 복제 요청을 처리하지 못했습니다.';
}

export function DocumentTreeCopy({ source, documents, projects, actorId, refreshWorkspace, onClose, onOpenCopy }: Props) {
  const heading = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleField = useRef<HTMLInputElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const pending = useRef<AbortController | null>(null);
  const [originalFields] = useState(() => initialFields(source));
  const [fields, setFields] = useState(originalFields);
  const [preview, setPreview] = useState<DocumentTreeCopyPreview | null>(null);
  const [previewPage, setPreviewPage] = useState(0);
  const [attempt, setAttempt] = useState<CopyRequest | null>(null);
  const [receiptUnavailable, setReceiptUnavailable] = useState(false);
  const [created, setCreated] = useState<DocPage | null>(null);
  const [busy, setBusy] = useState<Task | null>(null);
  const [error, setError] = useState('');
  const title = fields.title.trim();
  const parents = useMemo(() => documents.filter(page => page.projectId === fields.projectId), [documents, fields.projectId]);
  const parentLabels = useMemo(() => documentParentLabels(parents, documents), [documents, parents]);
  const spaceMissing = fields.projectId !== null && !projects.some(project => project.id === fields.projectId);
  const parentMissing = fields.parentId !== null && !parents.some(parent => parent.id === fields.parentId);
  const reviewable = Boolean(title && title.length <= TITLE_LIMIT && !spaceMissing && !parentMissing);
  const stalePreview = Boolean(preview && preview.expectedSourceVersion !== source.version);
  const dirty = !created && (Boolean(attempt || preview) || fields.title !== originalFields.title || fields.parentId !== originalFields.parentId ||
    fields.projectId !== originalFields.projectId || fields.includeDescendants !== originalFields.includeDescendants);
  const discardMessage = attempt
    ? '복제 결과가 아직 확인되지 않았습니다. 문서 목록에서 저장 여부를 확인할 수 있습니다. 닫을까요?'
    : '입력한 복제 위치와 미리보기를 버리고 닫을까요?';
  const path = `/documents/${encodeURIComponent(source.id)}`;

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const opener = document.activeElement;
    element.showModal();
    titleField.current?.focus({ preventScroll: true });
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
    window.addEventListener('donefac:navigate', guard);
    window.addEventListener('beforeunload', unload);
    window.addEventListener('donefac:workspace-imported', onClose);
    return () => {
      window.removeEventListener('donefac:navigate', guard);
      window.removeEventListener('beforeunload', unload);
      window.removeEventListener('donefac:workspace-imported', onClose);
    };
  }, [dirty, discardMessage, onClose]);

  useEffect(() => { if (created) resultHeading.current?.focus({ preventScroll: true }); }, [created]);

  function close() {
    if (!pending.current && (!dirty || window.confirm(discardMessage))) onClose();
  }

  function update(changes: Partial<CopyFields>) {
    setFields(previous => ({ ...previous, ...changes }));
    setPreview(null);
    setPreviewPage(0);
    setError('');
  }

  function start(task: Task) {
    const controller = new AbortController();
    pending.current = controller;
    setBusy(task);
    setError('');
    return controller;
  }

  function finish(controller: AbortController) {
    if (pending.current !== controller) return;
    pending.current = null;
    setBusy(null);
  }

  async function reload(controller: AbortController, message: string) {
    try {
      await refreshWorkspace();
      return !controller.signal.aborted;
    } catch {
      if (!controller.signal.aborted) setError(message);
      return false;
    }
  }

  async function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || attempt || created || !reviewable) return;
    const controller = start('preview');
    setPreview(null);
    setPreviewPage(0);
    try {
      const result = await api<DocumentTreeCopyPreview>(`${path}/copy-preview`, {
        method: 'POST', signal: controller.signal, headers: { 'X-Actor-Id': actorId },
        body: JSON.stringify({ ...fields, title, expectedSourceVersion: source.version }),
      });
      if (controller.signal.aborted) return;
      if (result?.sourceDocumentId !== source.id || !result.token || result.expectedSourceVersion !== source.version ||
        !Array.isArray(result.documents) || result.documents[0]?.id !== source.id) throw new Error('문서 복제 미리보기를 확인하지 못했습니다.');
      setPreview(result);
    } catch (cause) {
      if (controller.signal.aborted) return;
      const stale = cause instanceof ApiError && (cause.status === 404 || cause.status === 409);
      setError(stale ? STALE : requestError(cause));
      if (stale) await reload(controller, `${STALE} 최신 문서 목록을 불러오지 못했습니다.`);
    } finally { finish(controller); }
  }

  async function apply() {
    if (pending.current || created || receiptUnavailable) return;
    let request = attempt;
    if (!request) {
      if (!preview || stalePreview || !reviewable) return;
      const { title, projectId, parentId, includeDescendants, expectedSourceVersion, token } = preview;
      request = { actorId, projectId, body: JSON.stringify({ title, projectId, parentId, includeDescendants, expectedSourceVersion,
        token, requestId: newRequestId() }) };
    }
    if (request.actorId !== actorId) {
      setError('복제를 요청한 작업자로 전환한 뒤 다시 확인해 주세요.');
      return;
    }
    const controller = start('apply');
    setAttempt(request);
    try {
      const result = await api<DocPage>(`${path}/copy`, {
        method: 'POST', signal: controller.signal, headers: { 'X-Actor-Id': request.actorId }, body: request.body,
      });
      if (controller.signal.aborted) return;
      if (!result?.id || result.id === source.id || result.projectId !== request.projectId || result.authorId !== request.actorId) {
        throw new Error(UNCONFIRMED);
      }
      setCreated(result);
      setAttempt(null);
      await reload(controller, '복제본을 저장했습니다. 복제본을 열면 문서 목록을 다시 불러옵니다.');
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (!isDefiniteTemplateFailure(cause)) {
        setError(UNCONFIRMED);
        return;
      }
      const reason = templateErrorReason(cause);
      if (reason === 'request_conflict' || reason === 'result_unavailable') {
        setError(LOST_RECEIPT);
        setReceiptUnavailable(true);
        return;
      }
      setAttempt(null);
      if (reason === 'copy_preview_stale' || cause.status === 404 || cause.status === 409) {
        setPreview(null);
        setError(STALE);
        await reload(controller, `${STALE} 최신 문서 목록을 불러오지 못했습니다.`);
      } else setError(cause.message);
    } finally { finish(controller); }
  }

  async function openCopy() {
    if (!created || pending.current) return;
    if (!documents.some(page => page.id === created.id)) {
      const controller = start('refresh');
      const refreshed = await reload(controller, '문서 목록을 불러오지 못했습니다. 복제본을 다시 열어 주세요.');
      finish(controller);
      if (!refreshed) return;
    }
    if (onOpenCopy(created.id)) onClose();
  }

  const pageCount = Math.ceil((preview?.documents.length ?? 0) / PAGE_SIZE);
  return <dialog ref={dialog} className="docs-move-dialog docs-copy-dialog" aria-labelledby={heading} aria-busy={Boolean(busy)}
    onCancel={event => { event.preventDefault(); close(); }}>
    <header className="docs-modal-header">
      <h2 id={heading}>문서 복제</h2>
      <button className="btn btn-ghost docs-icon-button" type="button" aria-label="문서 복제 닫기" disabled={Boolean(busy)} onClick={close}>
        <X size={18} aria-hidden="true" />
      </button>
    </header>
    {created ? <div className="docs-move-body docs-copy-result">
      <div role="status">
        <h3 ref={resultHeading} tabIndex={-1}>복제본을 만들었습니다.</h3>
        <p>{created.title}</p>
      </div>
      {error && <p className="issue-form-error" role="alert">{error}</p>}
    </div> : <form className="docs-move-body" onSubmit={event => void review(event)}>
      <p><strong>{source.title}</strong>의 저장 버전 {source.version}을 새 초안으로 복제합니다.</p>
      <fieldset className="docs-move-fields docs-copy-fields" disabled={Boolean(busy || attempt)}>
        <label className="docs-modal-label docs-copy-title">복제본 제목
          <input ref={titleField} className="field" required maxLength={TITLE_LIMIT} value={fields.title}
            onChange={event => update({ title: event.currentTarget.value })} />
        </label>
        <label className="docs-modal-label">복제할 공간
          <select className="field" value={fields.projectId ?? ''}
            onChange={event => update({ projectId: event.currentTarget.value || null, parentId: null })}>
            <option value="">팀 공통 문서</option>
            {spaceMissing && <option value={fields.projectId ?? ''} disabled>선택한 공간을 찾을 수 없음</option>}
            {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        <label className="docs-modal-label">복제할 상위 문서
          <select className="field" value={fields.parentId ?? ''} onChange={event => update({ parentId: event.currentTarget.value || null })}>
            <option value="">최상위 문서</option>
            {parentMissing && <option value={fields.parentId ?? ''} disabled>선택한 상위 문서를 찾을 수 없음</option>}
            {parents.map(page => <option key={page.id} value={page.id}>{parentLabels.get(page.id)}</option>)}
          </select>
        </label>
        <label className="docs-copy-include">
          <input type="checkbox" checked={fields.includeDescendants} onChange={event => update({ includeDescendants: event.currentTarget.checked })} />하위 문서 포함
        </label>
        <button type="submit" className="btn" disabled={!reviewable}>{busy === 'preview' ? '복제 미리보기 확인 중…' : '복제 미리보기'}</button>
      </fieldset>
      {(error || stalePreview && !attempt) && <p className="issue-form-error" role="alert">{error || STALE}</p>}
      {preview && !stalePreview && <section className="docs-move-preview" aria-label="복제 대상 문서">
        <h3>{documentDestinationLabel(preview.destination, parentLabels)}</h3>
        <p role="status"><strong>문서 {preview.documents.length}개</strong> · 첨부파일 {preview.attachmentCount}개 ({preview.attachmentBytes.toLocaleString('ko-KR')}바이트)</p>
        <ul className="docs-move-list" role="list">
          {preview.documents.slice(previewPage * PAGE_SIZE, (previewPage + 1) * PAGE_SIZE)
            .map(page => <li key={page.id}><span>{page.title}</span> <small>· 버전 {page.version}</small></li>)}
        </ul>
        {pageCount > 1 && <nav className="docs-move-pagination" aria-label="복제 대상 문서 페이지">
          <button type="button" className="btn" disabled={Boolean(busy) || previewPage === 0} onClick={() => setPreviewPage(page => page - 1)}>이전 문서 목록</button>
          <span aria-live="polite">{previewPage + 1} / {pageCount}</span>
          <button type="button" className="btn" disabled={Boolean(busy) || previewPage + 1 >= pageCount} onClick={() => setPreviewPage(page => page + 1)}>다음 문서 목록</button>
        </nav>}
        {preview.warnings.length > 0 && <ul className="docs-move-list docs-copy-warnings" aria-label="복제 미리보기 안내" role="list">
          {preview.warnings.map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}
        </ul>}
      </section>}
    </form>}
    <footer className="docs-modal-footer">
      <button className="btn btn-ghost" type="button" disabled={Boolean(busy)} onClick={close}>{created ? '닫기' : '취소'}</button>
      {created ? <button className="btn btn-primary" type="button" disabled={Boolean(busy)} onClick={() => void openCopy()}>복제본 열기</button>
        : !receiptUnavailable && <button className="btn btn-primary" type="button"
          disabled={Boolean(busy) || (attempt ? attempt.actorId !== actorId : !preview || stalePreview || !reviewable)}
          onClick={() => void apply()}>{busy === 'apply' ? '문서 복제 확인 중…' : attempt ? '같은 요청으로 다시 확인' : '문서 복제 적용'}</button>}
    </footer>
  </dialog>;
}
