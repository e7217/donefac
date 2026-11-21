'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ArrowDownToLine, Loader2, X } from 'lucide-react';
import type { DocPage, FeatureProps, Project } from '../../shared/types';
import './document-offline-export.css';

export type DocumentOfflineExportScope = 'subtree' | 'project' | 'common';
type Source = 'saved' | 'published';
type Props = Pick<FeatureProps, 'actorId' | 'notify'> & {
  document?: Pick<DocPage, 'id' | 'title'>;
  project?: Pick<Project, 'id' | 'name'>;
  initialScope?: DocumentOfflineExportScope;
  onClose: () => void;
};

const ZIP_TYPE = 'application/zip';
const DEFAULT_FILENAME = 'teamspace-documents.zip';

function downloadFilename(disposition: string | null) {
  const encoded = disposition?.match(/(?:^|;)\s*filename\*=UTF-8'[^']*'([^;]+)/iu)?.[1];
  let filename: string | undefined;
  if (encoded) {
    try { filename = decodeURIComponent(encoded.trim()); } catch { /* Use the fallback filename. */ }
  }
  filename ??= disposition?.match(/(?:^|;)\s*filename=(?:"([^"]+)"|([^;]+))/iu)?.slice(1).find(Boolean)?.trim();
  return filename && /^[^/\\\u0000-\u001f\u007f]+\.zip$/iu.test(filename) ? filename : DEFAULT_FILENAME;
}

async function exportError(response: Response) {
  const error: unknown = await response.json().catch(() => null);
  if (error && typeof error === 'object' && 'error' in error && typeof error.error === 'string' && error.error.trim()) {
    return error.error;
  }
  switch (response.status) {
    case 400: return '내보낼 범위와 문서 버전을 확인해 주세요.';
    case 404: return '선택한 범위에서 내보낼 문서를 찾을 수 없습니다.';
    case 413: return '내보내기 한도를 넘었습니다. 문서와 하위 문서로 범위를 좁혀 주세요.';
    case 503: return '문서 또는 첨부파일을 읽지 못했습니다. 잠시 후 다시 시도해 주세요.';
    default: return 'Markdown ZIP을 내보내지 못했습니다. 다시 시도해 주세요.';
  }
}

function downloadZip(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function DocumentOfflineExport({ document, project, initialScope, actorId, notify, onClose }: Props) {
  const uid = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const scopeInput = useRef<HTMLSelectElement>(null);
  const request = useRef<AbortController | null>(null);
  const [selectedScope, setScope] = useState<DocumentOfflineExportScope>(initialScope ??
    (document ? 'subtree' : project ? 'project' : 'common'));
  const [source, setSource] = useState<Source>('saved');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [downloaded, setDownloaded] = useState('');
  const scope = (selectedScope === 'subtree' && !document) || (selectedScope === 'project' && !project) ? 'common' : selectedScope;
  const scopeName = scope === 'subtree' ? document?.title : scope === 'project' ? project?.name : undefined;

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    scopeInput.current?.focus({ preventScroll: true });
    return () => {
      request.current?.abort();
      element.close();
    };
  }, []);

  function close() {
    request.current?.abort();
    onClose();
  }

  function clearResult() {
    setError('');
    setDownloaded('');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.current) return;
    const query = new URLSearchParams({ scope: scope === 'subtree' ? 'subtree' : 'space', source });
    if (scope === 'subtree' && document) query.set('documentId', document.id);
    if (scope === 'project' && project) query.set('projectId', project.id);

    const controller = new AbortController();
    request.current = controller;
    clearResult();
    setBusy(true);
    try {
      const response = await fetch(`/api/document-exports/markdown.zip?${query}`, {
        headers: { Accept: ZIP_TYPE, ...(actorId ? { 'X-Actor-Id': actorId } : {}) },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await exportError(response));
      if (response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== ZIP_TYPE) {
        throw new Error('ZIP 파일 응답을 확인하지 못했습니다.');
      }
      const filename = downloadFilename(response.headers.get('Content-Disposition'));
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      if (!blob.size) throw new Error('ZIP 파일이 비어 있습니다.');
      downloadZip(blob, filename);
      setDownloaded(filename);
      notify('Markdown ZIP 내려받기를 시작했습니다.', 'success');
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof TypeError ? '연결이 끊겼습니다. 다시 시도해 주세요.'
        : cause instanceof Error ? cause.message : 'Markdown ZIP을 내보내지 못했습니다.');
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (!controller.signal.aborted) setBusy(false);
      }
    }
  }

  return <dialog ref={dialog} className="document-offline-export" aria-labelledby={`${uid}-title`} aria-describedby={`${uid}-description`}
    onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        event.stopPropagation();
      }
    }}>
    <header className="document-offline-export-heading">
      <h2 id={`${uid}-title`}>문서 Markdown ZIP 내보내기</h2>
      <button type="button" className="btn btn-ghost" aria-label="내보내기 닫기" onClick={close}>
        <X size={20} aria-hidden="true" />
      </button>
    </header>
    <p id={`${uid}-description`}>서버의 저장본 또는 승인·발행본으로 ZIP 파일을 만듭니다.</p>
    <form className="document-offline-export-form" onSubmit={submit}>
      <div>
        <label htmlFor={`${uid}-scope`}>내보낼 범위</label>
        <select id={`${uid}-scope`} className="field" ref={scopeInput} disabled={busy} value={scope}
          aria-describedby={scopeName ? `${uid}-scope-name` : undefined}
          onChange={event => { setScope(event.currentTarget.value as DocumentOfflineExportScope); clearResult(); }}>
          {document && <option value="subtree">선택한 문서와 하위 문서</option>}
          {project && <option value="project">현재 프로젝트 전체</option>}
          <option value="common">팀 공통 문서 전체</option>
        </select>
        {scopeName && <p id={`${uid}-scope-name`}>{scopeName}</p>}
      </div>
      <div>
        <label htmlFor={`${uid}-source`}>문서 버전</label>
        <select id={`${uid}-source`} className="field" disabled={busy} value={source} aria-describedby={`${uid}-source-help`}
          onChange={event => { setSource(event.currentTarget.value as Source); clearResult(); }}>
          <option value="saved">최신 저장본</option>
          <option value="published">최신 승인·발행본</option>
        </select>
        <p id={`${uid}-source-help`}>{source === 'saved' ? '서버에 저장된 가장 최근 문서 버전을 담습니다.'
          : '승인과 발행을 마친 문서의 최신 발행본을 담습니다.'}</p>
      </div>
      {error && <p className="document-offline-export-error" role="alert">{error}</p>}
      {busy && <p className="document-offline-export-status" role="status">ZIP 파일을 만드는 중입니다.</p>}
      {downloaded && <p className="document-offline-export-status" role="status">{downloaded}</p>}
      <div className="document-offline-export-actions">
        <button type="submit" className="btn btn-primary" aria-disabled={busy}>
          {busy ? <Loader2 size={16} className="spin" aria-hidden="true" /> : <ArrowDownToLine size={16} aria-hidden="true" />}
          Markdown ZIP 내려받기
        </button>
      </div>
    </form>
  </dialog>;
}
