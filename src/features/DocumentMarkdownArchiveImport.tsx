'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { FileInput, Loader2, X } from 'lucide-react';
import {
  MAX_MARKDOWN_ARCHIVE_BYTES, type DocumentMarkdownArchivePreview, type DocumentMarkdownArchiveResult,
} from '../../shared/document-markdown-archive';
import type { DocPage, FeatureProps, Project } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import './document-offline-export.css';
import './document-markdown-archive.css';

export type ArchiveImportNavigation = 'ready' | 'edited' | 'busy' | 'uncertain';

type Props = Pick<FeatureProps, 'actorId' | 'refresh' | 'openDocument'> & {
  projects: readonly Project[];
  documents: readonly DocPage[];
  initialProjectId: string | null;
  onNavigationChange: (state: ArchiveImportNavigation) => void;
  onClose: () => void;
};

type RequestPhase = 'preview' | 'apply' | 'refresh';

const phaseLabels: Record<RequestPhase, string> = {
  preview: 'ZIP 안의 문서와 첨부를 확인하는 중입니다.',
  apply: '문서와 첨부를 저장하는 중입니다.',
  refresh: '저장한 문서 목록을 불러오는 중입니다.',
};
const formatLabels: Record<DocumentMarkdownArchivePreview['format'], string> = {
  teamspace: 'Teamspace Markdown ZIP', docmost: 'Docmost Markdown ZIP', markdown: 'Markdown ZIP',
};

export function confirmMarkdownArchiveClose(state: ArchiveImportNavigation) {
  if (state === 'uncertain') return window.confirm('문서가 저장됐을 수 있습니다. 적용 결과 확인을 닫을까요?');
  return state === 'ready' || state === 'edited' && window.confirm('선택한 ZIP과 미리보기를 닫을까요?');
}

function hasUncertainApplyError(cause: unknown) {
  return !(cause instanceof ApiError) || cause.status >= 500 || [408, 425, 429, 499].includes(cause.status);
}

export function DocumentMarkdownArchiveImport({ projects, documents, initialProjectId, actorId, refresh, openDocument, onNavigationChange, onClose }: Props) {
  const uid = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const scopeInput = useRef<HTMLSelectElement>(null);
  const appliedHeading = useRef<HTMLHeadingElement>(null);
  const request = useRef<AbortController | null>(null);
  const [projectId, setProjectId] = useState(initialProjectId ?? '');
  const [parentId, setParentId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<DocumentMarkdownArchivePreview | null>(null);
  const [result, setResult] = useState<DocumentMarkdownArchiveResult | null>(null);
  const [refreshPending, setRefreshPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [phase, setPhase] = useState<RequestPhase | null>(null);
  const [error, setError] = useState('');

  const parents = documents.filter(page => (page.projectId ?? '') === projectId);
  const missingDestination = Boolean((projectId && !projects.some(project => project.id === projectId)) ||
    (parentId && !parents.some(page => page.id === parentId)));
  const inputsLocked = Boolean(phase || uncertain || result);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    scopeInput.current?.focus({ preventScroll: true });
    return () => {
      request.current?.abort();
      request.current = null;
      onNavigationChange('ready');
      element.close();
    };
  }, [onNavigationChange]);

  useEffect(() => {
    if (result) appliedHeading.current?.focus({ preventScroll: true });
  }, [result]);

  function invalidatePreview() {
    setPreview(null);
    setError('');
  }

  function selectFile(next: File | null) {
    invalidatePreview();
    const problem = next && (!next.size ? '내용이 있는 ZIP 파일을 선택해 주세요.'
      : !/\.zip$/iu.test(next.name) ? 'ZIP 파일을 선택해 주세요.'
        : next.size > MAX_MARKDOWN_ARCHIVE_BYTES ? 'ZIP 파일은 64 MiB 이하여야 합니다.' : '');
    const accepted = problem ? null : next;
    setFile(accepted);
    setError(problem || '');
    onNavigationChange(accepted ? 'edited' : 'ready');
  }

  function begin(nextPhase: RequestPhase) {
    if (request.current) return null;
    const controller = new AbortController();
    request.current = controller;
    onNavigationChange('busy');
    setError('');
    setPhase(nextPhase);
    return controller;
  }

  function finish(controller: AbortController, nextState: ArchiveImportNavigation) {
    if (request.current !== controller) return;
    request.current = null;
    onNavigationChange(nextState);
    setPhase(null);
  }

  function sendArchive<T>(action: 'preview' | 'apply', params: URLSearchParams, body: File, signal: AbortSignal) {
    return api<T>(`/document-markdown-import/${action}?${params}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': actorId }, body, signal,
    });
  }

  async function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || inputsLocked || missingDestination) return;
    const controller = begin('preview');
    if (!controller) return;
    setPreview(null);
    try {
      const next = await sendArchive<DocumentMarkdownArchivePreview>('preview', new URLSearchParams({ projectId, parentId }), file, controller.signal);
      if (!controller.signal.aborted) setPreview(next);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof ApiError ? cause.message : 'ZIP 미리보기를 불러오지 못했습니다. 다시 시도해 주세요.');
    } finally { finish(controller, 'edited'); }
  }

  async function refreshImported(controller: AbortController) {
    try {
      await refresh();
      if (!controller.signal.aborted) setRefreshPending(false);
    } catch {
      if (!controller.signal.aborted) setError('문서는 저장됐습니다. 문서 목록을 다시 불러와 주세요.');
    }
  }

  async function apply() {
    if (!file || !preview || result || (missingDestination && !uncertain)) return;
    const controller = begin('apply');
    if (!controller) return;
    let nextState: ArchiveImportNavigation = 'edited';
    try {
      const applied = await sendArchive<DocumentMarkdownArchiveResult>('apply', new URLSearchParams({ previewId: preview.id }), file, controller.signal);
      if (controller.signal.aborted) return;
      nextState = 'ready';
      setUncertain(false);
      setResult(applied);
      setRefreshPending(true);
      setPhase('refresh');
      await refreshImported(controller);
    } catch (cause) {
      if (controller.signal.aborted) return;
      const recheck = uncertain || hasUncertainApplyError(cause);
      setUncertain(recheck);
      nextState = recheck ? 'uncertain' : 'edited';
      setError(cause instanceof ApiError ? cause.message : '응답을 확인하지 못했습니다. 같은 ZIP으로 적용 결과를 다시 확인해 주세요.');
      if (!recheck) setPreview(null);
    } finally { finish(controller, nextState); }
  }

  async function retryRefresh() {
    const controller = begin('refresh');
    if (!controller) return;
    try { await refreshImported(controller); }
    finally { finish(controller, 'ready'); }
  }

  function close() {
    if (request.current) return;
    const state = uncertain ? 'uncertain' : file && !result ? 'edited' : 'ready';
    if (confirmMarkdownArchiveClose(state)) onClose();
  }

  return <dialog ref={dialog} className="document-offline-export document-markdown-archive-import" aria-labelledby={`${uid}-title`}
    onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        event.stopPropagation();
      }
    }}>
    <header className="document-offline-export-heading">
      <h2 id={`${uid}-title`}>Markdown ZIP 가져오기</h2>
      <button type="button" className="btn btn-ghost" aria-label="가져오기 닫기" disabled={Boolean(phase)} onClick={close}>
        <X size={20} aria-hidden="true" />
      </button>
    </header>
    {!result && <form className="document-offline-export-form" onSubmit={analyze}>
      <fieldset className="document-markdown-archive-fields" disabled={inputsLocked}>
        <div>
          <label htmlFor={`${uid}-project`}>가져올 문서 공간</label>
          <select id={`${uid}-project`} className="field" ref={scopeInput} value={projectId}
            onChange={event => { setProjectId(event.currentTarget.value); setParentId(''); invalidatePreview(); }}>
            <option value="">팀 공통</option>
            {projectId && !projects.some(project => project.id === projectId) && <option value={projectId} disabled>현재 문서 공간 없음</option>}
            {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${uid}-parent`}>상위 문서</label>
          <select id={`${uid}-parent`} className="field" value={parentId}
            onChange={event => { setParentId(event.currentTarget.value); invalidatePreview(); }}>
            <option value="">공간의 최상위</option>
            {parentId && !parents.some(parent => parent.id === parentId) && <option value={parentId} disabled>현재 상위 문서 없음</option>}
            {parents.map(parent => <option key={parent.id} value={parent.id}>{parent.title}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${uid}-file`}>가져올 ZIP 파일</label>
          <input id={`${uid}-file`} type="file" className="field" accept=".zip,application/zip" aria-describedby={`${uid}-limit`}
            onChange={event => selectFile(event.currentTarget.files?.[0] ?? null)} />
          <p id={`${uid}-limit`}>Markdown 문서와 첨부가 담긴 ZIP, 최대 64 MiB</p>
        </div>
      </fieldset>
      <div className="document-offline-export-actions">
        <button type="submit" className="btn" disabled={!file || inputsLocked || missingDestination}>ZIP 미리보기</button>
      </div>
    </form>}
    {phase && <p className="document-offline-export-status" role="status"><Loader2 size={14} className="spin" aria-hidden="true" /> {phaseLabels[phase]}</p>}
    {error && <p className="document-offline-export-error" role="alert">{error}</p>}
    {!result && preview && <section className="document-markdown-archive-review" aria-label="ZIP 가져오기 미리보기">
      <h3>{formatLabels[preview.format]}</h3>
      <p role="status">문서 {preview.pages.length}개 · 첨부 {preview.attachmentCount}개</p>
      <ul className="document-markdown-archive-pages" aria-label="가져올 문서 목록">
        {preview.pages.map(item => <li key={item.path}>
          <strong>{item.title}</strong>
          <small>{item.path}{item.attachmentCount > 0 && ` · 첨부 ${item.attachmentCount}개`}</small>
        </li>)}
      </ul>
      {preview.warnings.length > 0 && <details className="document-markdown-archive-warnings" open><summary>확인할 항목 {preview.warnings.length}개</summary>
        <ul>{preview.warnings.map((warning, index) => <li key={index}>{warning.path && <strong>{warning.path} </strong>}{warning.message}</li>)}</ul>
      </details>}
      <div className="document-offline-export-actions">
        <button type="button" className="btn btn-primary" disabled={Boolean(phase) || (missingDestination && !uncertain)} onClick={() => void apply()}>
          <FileInput size={15} aria-hidden="true" />{uncertain ? '적용 결과 다시 확인' : '문서와 첨부 가져오기'}
        </button>
      </div>
    </section>}
    {result && <section className="document-markdown-archive-review" aria-labelledby={`${uid}-applied`}>
      <h3 ref={appliedHeading} id={`${uid}-applied`} tabIndex={-1}>가져오기 완료</h3>
      <p>문서 {result.documentIds.length}개 · 첨부 {result.attachmentCount}개</p>
      {!refreshPending && <ul className="document-markdown-archive-pages" aria-label="가져온 최상위 문서">
        {result.rootIds.flatMap(id => {
          const page = documents.find(document => document.id === id);
          return page ? [<li key={id}><button type="button" className="btn btn-ghost" onClick={() => openDocument(id)}>{page.title} 열기</button></li>] : [];
        })}
      </ul>}
      {refreshPending && !phase && <div className="document-offline-export-actions">
        <button type="button" className="btn" onClick={() => void retryRefresh()}>문서 목록 다시 불러오기</button>
      </div>}
    </section>}
  </dialog>;
}
