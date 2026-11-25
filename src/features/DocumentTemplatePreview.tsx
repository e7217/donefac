'use client';

import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import type { DocumentTemplateSummary, RichContent, WorkspaceSnapshot } from '../../shared/types';
import { api, ApiError } from '../lib/api';

type Preview = { id: string; version: number; content: RichContent };
type Result = { state: 'loading' } | { state: 'ready'; content: RichContent } | { state: 'error'; message: string; stale: boolean };

function keepLocation() {}

const TemplateBody = lazy(async () => {
  const { DocumentBlocksProvider, ReadonlyDocumentContent } = await import('./DocumentBlocks');
  return { default: function TemplateBody({ data, content }: { data: WorkspaceSnapshot; content: RichContent }) {
    return <DocumentBlocksProvider data={data} documentId={null} openIssue={keepLocation} openDocument={keepLocation}>
      <ReadonlyDocumentContent content={content} mode="preview" />
    </DocumentBlocksProvider>;
  } };
});

export function DocumentTemplatePreview({ template, projectId, data, disabled, reloadCatalog }: {
  template: DocumentTemplateSummary;
  projectId: string | null;
  data: WorkspaceSnapshot;
  disabled: boolean;
  reloadCatalog: () => void;
}) {
  const id = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const visible = open && !disabled;
  return <div className="document-template-preview" onKeyDown={event => {
    if (!visible || event.key !== 'Escape' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    toggle.current?.focus({ preventScroll: true });
  }}>
    <button type="button" ref={toggle} className="btn" disabled={disabled} aria-expanded={visible}
      aria-controls={visible ? id : undefined} onClick={() => setOpen(value => !value)}>
      {visible ? '템플릿 미리보기 닫기' : '템플릿 미리보기'}
    </button>
    {visible && <section id={id} aria-label="템플릿 저장본 미리보기" className="document-template-preview-region" tabIndex={0}>
      <PreviewContent templateId={template.id} version={template.version} projectId={projectId} data={data} reloadCatalog={reloadCatalog} />
    </section>}
  </div>;
}

function PreviewContent({ templateId, version, projectId, data, reloadCatalog }: {
  templateId: string;
  version: number;
  projectId: string | null;
  data: WorkspaceSnapshot;
  reloadCatalog: () => void;
}) {
  const [result, setResult] = useState<Result>({ state: 'loading' });
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const request = new AbortController();
    const query = new URLSearchParams({ expectedVersion: String(version) });
    if (projectId !== null) query.set('projectId', projectId);
    void api<Preview>(`/document-templates/${encodeURIComponent(templateId)}/preview?${query}`, {
      signal: request.signal, cache: 'no-store',
    }).then(preview => {
      if (request.signal.aborted) return;
      if (preview?.id !== templateId || preview.version !== version || preview.content?.type !== 'doc') {
        throw new Error('템플릿 저장본을 확인할 수 없습니다.');
      }
      setResult({ state: 'ready', content: preview.content });
    }).catch(error => {
      if (request.signal.aborted) return;
      const stale = error instanceof ApiError && (error.status === 409 || error.status === 404);
      setResult({ state: 'error', message: error instanceof Error ? error.message : '템플릿을 미리볼 수 없습니다.', stale });
    });
    return () => request.abort();
  }, [templateId, version, projectId, retry]);

  const loading = <p role="status">템플릿 저장본을 불러오는 중입니다.</p>;
  if (result.state === 'loading') return loading;
  if (result.state === 'error') return <div>
    <p className="document-template-error" role="alert">{result.message}</p>
    <button type="button" className="btn" onClick={() => {
      if (result.stale) reloadCatalog();
      else { setResult({ state: 'loading' }); setRetry(value => value + 1); }
    }}>{result.stale ? '팀 템플릿 다시 불러오기' : '미리보기 다시 불러오기'}</button>
  </div>;
  return <Suspense fallback={loading}><TemplateBody data={data} content={result.content} /></Suspense>;
}
