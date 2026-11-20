'use client';

import { lazy, Suspense, useLayoutEffect, useRef } from 'react';
import { ArrowUpRight, X } from 'lucide-react';
import type { DocPage, WorkspaceSnapshot } from '../../shared/types';
import './issue-document-preview.css';

type DocumentReaderProps = {
  data: WorkspaceSnapshot;
  document: DocPage;
  openIssue: (id: string) => void;
  openDocument: (id: string) => void;
};

const DocumentReader = lazy(async () => {
  const { DocumentBlocksProvider, ReadonlyDocumentContent } = await import('./DocumentBlocks');
  function DocumentReader({ data, document, openIssue, openDocument }: DocumentReaderProps) {
    return <DocumentBlocksProvider data={data} documentId={document.id} content={document.content}
      openIssue={openIssue} openDocument={openDocument}>
      <ReadonlyDocumentContent content={document.content} documentId={document.id} nodeBudget={30_000} showOutline />
    </DocumentBlocksProvider>;
  }
  return { default: DocumentReader };
});

export function IssueDocumentPreview({ data, document, onClose, onOpenDocument, openIssue, openDocument }: DocumentReaderProps & {
  onClose: () => void;
  onOpenDocument: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const openDocumentButton = useRef<HTMLButtonElement>(null);
  const backdropPress = useRef(false);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    closeButton.current?.focus({ preventScroll: true });
    return () => element.close();
  }, []);

  return <dialog ref={dialog} className="issue-document-preview" aria-label="연결 문서 미리보기"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onPointerDown={event => { backdropPress.current = event.target === event.currentTarget; }}
    onClick={event => {
      if (backdropPress.current && event.target === event.currentTarget) onClose();
      backdropPress.current = false;
    }}
    onKeyDown={event => {
      if (event.key === 'Escape') event.stopPropagation();
      if (event.key === 'Tab') {
        const first = closeButton.current;
        const last = openDocumentButton.current;
        if (event.shiftKey ? event.target === first : event.target === last) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      }
      if ((event.ctrlKey || event.metaKey) && ['k', 's'].includes(event.key.toLowerCase())) {
        event.preventDefault();
        event.stopPropagation();
      }
    }}>
    <header className="issue-document-preview-header">
      <div>
        <p>현재 저장본 · 버전 {document.version} · 읽기 전용</p>
        <h2>{document.title || '제목 없는 문서'}</h2>
      </div>
      <button ref={closeButton} type="button" className="btn btn-ghost" aria-label="문서 미리보기 닫기" onClick={onClose}>
        <X size={19} aria-hidden="true" />
      </button>
    </header>
    <div className="issue-document-preview-body" role="region" aria-label="미리보기 본문" tabIndex={0}>
      <Suspense fallback={<p role="status">문서를 불러오는 중…</p>}>
        <DocumentReader data={data} document={document} openIssue={openIssue} openDocument={openDocument} />
      </Suspense>
    </div>
    <footer className="issue-document-preview-footer">
      <button ref={openDocumentButton} type="button" className="btn" onClick={onOpenDocument}>
        문서 공간에서 열기 <ArrowUpRight size={15} aria-hidden="true" />
      </button>
    </footer>
  </dialog>;
}
