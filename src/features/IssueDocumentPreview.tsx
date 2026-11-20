'use client';

import { lazy, memo, Suspense, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUpRight, X } from 'lucide-react';
import type { DocPage, WorkspaceSnapshot } from '../../shared/types';
import './issue-document-preview.css';

type DocumentReaderProps = {
  data: WorkspaceSnapshot;
  document: DocPage;
  openIssue: (id: string) => void;
  openDocument: (id: string) => void;
  referenceIssueId?: string;
};

const DocumentReader = lazy(async () => {
  const { DocumentBlocksProvider, ReadonlyDocumentContent } = await import('./DocumentBlocks');
  const DocumentReader = memo(function DocumentReader({ data, document, openIssue, openDocument, referenceIssueId, onReady }: DocumentReaderProps & {
    onReady: () => void;
  }) {
    useLayoutEffect(onReady, [onReady]);
    return <DocumentBlocksProvider data={data} documentId={document.id} content={document.content}
      openIssue={openIssue} openDocument={openDocument}>
      <ReadonlyDocumentContent content={document.content} documentId={document.id} nodeBudget={30_000} showOutline referenceIssueId={referenceIssueId} />
    </DocumentBlocksProvider>;
  });
  return { default: DocumentReader };
});

export function IssueDocumentPreview({ data, document, onClose, onOpenDocument, openIssue, openDocument, referenceIssueId }: DocumentReaderProps & {
  onClose: () => void;
  onOpenDocument: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const openDocumentButton = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const activeReference = useRef<HTMLButtonElement | null>(null);
  const backdropPress = useRef(false);
  const [bodyReady, setBodyReady] = useState(false);
  const [navigation, setNavigation] = useState<{ version: number; issueId: string; message: string }>();
  const markBodyReady = useCallback(() => setBodyReady(true), []);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    closeButton.current?.focus({ preventScroll: true });
    return () => element.close();
  }, []);

  useLayoutEffect(() => {
    activeReference.current?.removeAttribute('aria-current');
    activeReference.current = null;
  }, [document.version, referenceIssueId]);

  function moveToNextReference() {
    const container = body.current;
    if (!container || !referenceIssueId) return;
    const references = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-preview-issue-reference]'));
    const previous = activeReference.current;
    if (!references.length) {
      setNavigation({ version: document.version, issueId: referenceIssueId, message: '미리보기에서 참조 위치를 표시할 수 없습니다.' });
      return;
    }
    const index = previous ? (references.indexOf(previous) + 1) % references.length : 0;
    const reference = references[index];
    previous?.removeAttribute('aria-current');
    reference.setAttribute('aria-current', 'location');
    activeReference.current = reference;
    for (let parent = reference.parentElement; parent && parent !== container; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    }
    for (let parent = reference.parentElement; parent; parent = parent.parentElement) {
      if (parent.scrollWidth > parent.clientWidth && /^(auto|scroll)$/.test(getComputedStyle(parent).overflowX)) {
        const target = reference.getBoundingClientRect();
        const bounds = parent.getBoundingClientRect();
        parent.scrollLeft += target.left < bounds.left || target.width > parent.clientWidth
          ? target.left - bounds.left
          : Math.max(0, target.right - bounds.left - parent.clientWidth);
      }
      if (parent === container) break;
    }
    const target = reference.getBoundingClientRect();
    container.scrollTop += target.top - container.getBoundingClientRect().top + (target.height - container.clientHeight) / 2;
    setNavigation({ version: document.version, issueId: referenceIssueId, message: `${references.length}곳 중 ${index + 1}번째 본문 참조` });
  }

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
    <div ref={body} className="issue-document-preview-body" role="region" aria-label="미리보기 본문" tabIndex={0}>
      <Suspense fallback={<p role="status">문서를 불러오는 중…</p>}>
        <DocumentReader data={data} document={document} openIssue={openIssue} openDocument={openDocument}
          referenceIssueId={referenceIssueId} onReady={markBodyReady} />
      </Suspense>
    </div>
    <footer className="issue-document-preview-footer">
      {referenceIssueId && <>
        <span className="issue-document-preview-reference-status" role="status">
          {navigation?.version === document.version && navigation.issueId === referenceIssueId ? navigation.message : ''}
        </span>
        <button type="button" className="btn" disabled={!bodyReady} onClick={moveToNextReference}>본문 참조로 이동</button>
      </>}
      <button ref={openDocumentButton} type="button" className="btn" onClick={onOpenDocument}>
        문서 공간에서 열기 <ArrowUpRight size={15} aria-hidden="true" />
      </button>
    </footer>
  </dialog>;
}
