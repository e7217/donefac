'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Archive, FileStack, Plus, RotateCcw, X } from 'lucide-react';
import type { DocPage, DocumentTemplateSummary, FeatureProps } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import { newRequestId } from '../lib/request-id';
import './document-templates.css';

type TemplateSource = Pick<DocPage, 'id' | 'title' | 'version' | 'projectId'>;
type CatalogResult = { projectId: string | null; revision: number } & (
  { state: 'ready'; templates: DocumentTemplateSummary[] } | { state: 'error'; message: string }
);
type Attempt = { actorId: string; body: string };
const RECHECK_REGISTRATION = '저장 결과를 확인할 수 없습니다. 같은 요청으로 다시 확인해 주세요.';
const TEMPLATE_NAME_LIMIT = 100;

export function templateErrorReason(error: ApiError): unknown {
  if (error.details && typeof error.details === 'object' && 'reason' in error.details) return error.details.reason;
}

export function isDefiniteTemplateFailure(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status >= 400 && error.status < 500 && ![401, 403, 408, 425, 429, 499].includes(error.status);
}

export function useDocumentTemplates(projectId: string | null, enabled: boolean, includeArchived = false) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<CatalogResult | null>(null);
  const reload = useCallback(() => setRevision(value => value + 1), []);

  useEffect(() => {
    if (!enabled) return;
    const request = new AbortController();
    const query = new URLSearchParams();
    if (projectId !== null) query.set('projectId', projectId);
    if (includeArchived) query.set('includeArchived', '1');
    const suffix = query.size ? `?${query}` : '';
    void api<DocumentTemplateSummary[]>(`/document-templates${suffix}`, { signal: request.signal, cache: 'no-store' }).then(templates => {
      if (!request.signal.aborted) setResult({ projectId, revision, state: 'ready', templates });
    }).catch(error => {
      if (!request.signal.aborted) setResult({ projectId, revision, state: 'error', message: error instanceof Error ? error.message : '템플릿을 불러오지 못했습니다.' });
    });
    return () => request.abort();
  }, [enabled, includeArchived, projectId, revision]);

  // During a scope or revision change, a late response must not be selectable in the next scope.
  const current = result?.projectId === projectId && result.revision === revision ? result : null;
  return { catalog: current, reload };
}

export function DocumentTemplatePicker({ catalog, reload, value, projectName, disabled, onChoose }: {
  catalog: ReturnType<typeof useDocumentTemplates>['catalog'];
  reload: () => void;
  value: string;
  projectName?: string;
  disabled: boolean;
  onChoose: (template: DocumentTemplateSummary | null) => void;
}) {
  const templates = catalog?.state === 'ready' ? catalog.templates : [];
  const selectedMissing = Boolean(value && !templates.some(template => template.id === value));
  const commonNames = new Set(templates.filter(template => template.projectId === null).map(template => template.name.normalize('NFC').toLowerCase()));
  const projectNames = new Set(templates.filter(template => template.projectId !== null).map(template => template.name.normalize('NFC').toLowerCase()));
  if (catalog?.state === 'error' && !disabled) return <div className="document-template-picker-status">
    <span role="status">{catalog.message}</span><button type="button" className="btn" onClick={reload}>팀 템플릿 다시 불러오기</button>
  </div>;
  if (!templates.length && !value) return null;
  return <label className="docs-modal-label document-template-picker">팀 템플릿
    <select className="field" value={value} disabled={disabled || !catalog} onChange={event => {
      onChoose(templates.find(template => template.id === event.target.value) ?? null);
    }}>
      <option value="">선택하세요</option>
      {selectedMissing && <option value={value} disabled>{catalog ? '현재 사용할 수 없는 템플릿' : '템플릿 확인 중…'}</option>}
      {templates.map(template => {
        const key = template.name.normalize('NFC').toLowerCase();
        const disambiguated = commonNames.has(key) && projectNames.has(key);
        const scope = template.projectId === null ? '팀 공통' : projectName ?? '프로젝트';
        return <option value={template.id} key={template.id}>{template.name}{disambiguated ? ` · ${scope}` : ''}</option>;
      })}
    </select>
  </label>;
}

type ManagerProps = Pick<FeatureProps, 'actorId' | 'refresh' | 'notify'> & {
  projectId: string | null;
  scopeLabel: string;
  source?: TemplateSource;
  latestSource?: TemplateSource;
  onClose: () => void;
};

export function DocumentTemplatesManager({ projectId, scopeLabel, source, latestSource, actorId, refresh, notify, onClose }: ManagerProps) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const attempt = useRef<Attempt | null>(null);
  const dirty = useRef(false);
  const [approvedSource, setApprovedSource] = useState(source);
  const [selected, setSelected] = useState<DocumentTemplateSummary | null>(null);
  const [name, setName] = useState(source?.title.slice(0, TEMPLATE_NAME_LIMIT).toWellFormed() ?? '');
  const [busy, setBusy] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [reviewSource, setReviewSource] = useState(false);
  const [reviewTemplate, setReviewTemplate] = useState(false);
  const [registrationRejected, setRegistrationRejected] = useState(false);
  const [error, setError] = useState('');
  const { catalog, reload } = useDocumentTemplates(projectId, true, true);

  const templates = catalog?.state === 'ready' ? catalog.templates.filter(template => template.projectId === projectId) : [];
  const currentTemplate = templates.find(template => template.id === selected?.id);
  const sourceAvailable = Boolean(approvedSource && latestSource?.id === approvedSource.id && latestSource.projectId === projectId);
  const canReviewSource = Boolean(approvedSource && latestSource && sourceAvailable && latestSource.version !== approvedSource.version);
  const sourceChanged = Boolean(approvedSource && (!sourceAvailable || reviewSource || canReviewSource));
  const templateChanged = Boolean(selected && (reviewTemplate || (catalog?.state === 'ready' && currentTemplate?.version !== selected.version)));
  const normalizedName = name.trim().normalize('NFC');
  const nameChanged = normalizedName !== (selected?.name ?? approvedSource?.title.slice(0, TEMPLATE_NAME_LIMIT).toWellFormed().trim().normalize('NFC') ?? '');
  useLayoutEffect(() => { dirty.current = nameChanged; }, [nameChanged]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    (source ? nameInput.current : closeButton.current)?.focus({ preventScroll: true });
    return () => element.close();
  }, [source]);

  useEffect(() => {
    if (recovering && !busy) submitButton.current?.focus({ preventScroll: true });
  }, [busy, recovering]);

  const confirmDiscard = useCallback(() => {
    if (attempt.current) return window.confirm('템플릿이 저장됐을 수 있습니다. 템플릿 목록에서 확인할 수 있습니다. 계속할까요?');
    return !dirty.current || window.confirm('작성 중인 템플릿 이름을 버릴까요?');
  }, []);

  useEffect(() => {
    function guard(event: Event) {
      if (event.defaultPrevented) return;
      if (pending.current) {
        event.preventDefault();
        notify('템플릿을 저장한 뒤 이동해 주세요.', 'error');
      } else if (!confirmDiscard()) event.preventDefault();
      else afterAcceptedNavigation(event, onClose);
    }
    function unload(event: BeforeUnloadEvent) {
      if (!pending.current && !attempt.current && !dirty.current) return;
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('teamspace:navigate', guard);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('teamspace:navigate', guard);
      window.removeEventListener('beforeunload', unload);
    };
  }, [confirmDiscard, notify, onClose]);

  function close() {
    if (!pending.current && confirmDiscard()) onClose();
  }

  function choose(template: DocumentTemplateSummary | null) {
    if (pending.current || !confirmDiscard()) return;
    setSelected(template);
    setName(template?.name ?? approvedSource?.title.slice(0, TEMPLATE_NAME_LIMIT).toWellFormed() ?? '');
    setError('');
    setReviewTemplate(false);
    setRegistrationRejected(false);
  }

  function setSavedTemplate(template: DocumentTemplateSummary, preserveName = false) {
    setSelected(template);
    if (!preserveName) setName(template.name);
    setReviewTemplate(false);
    reload();
  }

  function acceptLatestTemplate() {
    if (!currentTemplate) return;
    if (!nameChanged) setName(currentTemplate.name);
    setSelected(currentTemplate);
    setReviewTemplate(false);
    setError('');
  }

  function acceptLatestSource() {
    if (!latestSource || !canReviewSource) return;
    setApprovedSource(latestSource);
    setReviewSource(false);
    setError('');
  }

  async function updateTemplate(changes: { name?: string; archived?: boolean; sourceDocumentId?: string; expectedDocumentVersion?: number }) {
    if (!selected || templateChanged || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await api<DocumentTemplateSummary>(`/document-templates/${encodeURIComponent(selected.id)}`, {
        method: 'PATCH', headers: { 'X-Actor-Id': actorId }, body: JSON.stringify({ expectedVersion: selected.version, ...changes }),
      });
      if (result?.id !== selected.id || !Number.isSafeInteger(result.version)) throw new Error(RECHECK_REGISTRATION);
      setSavedTemplate(result, changes.name === undefined && nameChanged);
      notify('문서 템플릿을 변경했습니다.', 'success');
    } catch (cause) {
      if (cause instanceof ApiError) {
        const reason = templateErrorReason(cause);
        if (reason === 'template_version_conflict' || reason === 'template_not_found') { setReviewTemplate(true); reload(); }
        if (reason === 'source_version_conflict' || reason === 'source_not_found') {
          setReviewSource(true);
          await refresh().catch(() => {});
        }
      }
      if (!isDefiniteTemplateFailure(cause)) reload();
      setError(cause instanceof Error ? cause.message : '템플릿을 변경하지 못했습니다.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!normalizedName || pending.current) return;
    if (selected) {
      if (nameChanged) await updateTemplate({ name: normalizedName });
      return;
    }
    if (!approvedSource || registrationRejected || (sourceChanged && !attempt.current)) return;
    const replay = Boolean(attempt.current);
    const request = attempt.current ?? { actorId, body: JSON.stringify({ requestId: newRequestId(), name: normalizedName,
      sourceDocumentId: approvedSource.id, expectedDocumentVersion: approvedSource.version }) };
    attempt.current = request;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await api<DocumentTemplateSummary>('/document-templates', { method: 'POST', headers: { 'X-Actor-Id': request.actorId }, body: request.body });
      if (!result?.id || result.projectId !== projectId || !Number.isSafeInteger(result.version)) throw new Error(RECHECK_REGISTRATION);
      attempt.current = null;
      setRecovering(false);
      setSavedTemplate(result);
      notify(replay ? '템플릿 저장 결과를 확인했습니다.' : '팀 템플릿을 저장했습니다.', 'success');
    } catch (cause) {
      if (!isDefiniteTemplateFailure(cause)) {
        setRecovering(true);
        setError(RECHECK_REGISTRATION);
      } else {
        const reason = templateErrorReason(cause);
        attempt.current = null;
        setRecovering(false);
        setError(cause.message);
        if (reason === 'source_version_conflict' || reason === 'source_not_found') {
          setReviewSource(true);
          await refresh().catch(() => {});
        }
        if (replay && (reason === 'request_conflict' || reason === 'request_unavailable')) {
          setRegistrationRejected(true);
          reload();
        }
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return <dialog ref={dialog} className="document-templates-dialog" aria-labelledby={titleId} onCancel={event => {
    event.preventDefault(); close();
  }} onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); }
  }}>
    <header className="document-templates-header">
      <div><h2 id={titleId}>팀 문서 템플릿</h2><p>{scopeLabel}</p></div>
      <button ref={closeButton} className="btn btn-ghost docs-icon-button" type="button" aria-label="닫기" disabled={busy} onClick={close}><X size={18} aria-hidden="true" /></button>
    </header>
    {approvedSource && <p className="document-templates-source">{approvedSource.title} · 저장본 {approvedSource.version}</p>}
    {(approvedSource || selected) && <form className="document-templates-form" onSubmit={submit}>
      <label className="docs-modal-label">템플릿 이름
        <input ref={nameInput} className="field" maxLength={TEMPLATE_NAME_LIMIT} required value={name}
          onChange={event => setName(event.target.value)} disabled={busy || recovering} />
      </label>
      <div className="document-template-actions">
        <button ref={submitButton} className="btn btn-primary" type="submit" disabled={busy || !normalizedName || registrationRejected ||
          (selected ? !nameChanged || templateChanged : !recovering && sourceChanged)}>
          {busy ? '저장 중…' : recovering ? '저장 다시 확인' : selected ? '이름 저장' : '템플릿 저장'}
        </button>
        {selected && <>
          {approvedSource && <button className="btn" type="button" disabled={busy || templateChanged || sourceChanged} onClick={() => {
            if (window.confirm('이 템플릿 본문을 현재 문서의 저장본으로 교체할까요?')) {
              void updateTemplate({ sourceDocumentId: approvedSource.id, expectedDocumentVersion: approvedSource.version });
            }
          }}>저장본으로 본문 교체</button>}
          <button className="btn" type="button" disabled={busy || templateChanged} onClick={() => void updateTemplate({ archived: !selected.archived })}>
            {selected.archived ? <RotateCcw size={14} aria-hidden="true" /> : <Archive size={14} aria-hidden="true" />}{selected.archived ? '복원' : '보관'}
          </button>
          {approvedSource && <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => choose(null)}><Plus size={14} aria-hidden="true" />새 템플릿 등록</button>}
        </>}
      </div>
    </form>}
    {error && <p className="document-template-error" role="alert">{error}</p>}
    {sourceChanged && !recovering && <div className="document-template-picker-status">
      <span>{sourceAvailable ? '서버의 최신 문서 저장본을 다시 확인해 주세요.' : '현재 공간에서 원본 문서를 찾을 수 없습니다.'}</span>
      {canReviewSource ? <button type="button" className="btn" disabled={busy} onClick={acceptLatestSource}>최신 저장본 사용</button>
        : sourceAvailable && <button type="button" className="btn" disabled={busy} onClick={() => void refresh().catch(cause => {
          setError(cause instanceof Error ? cause.message : '원본 문서를 새로 불러오지 못했습니다.');
        })}>문서 다시 불러오기</button>}
    </div>}
    {templateChanged && <div className="document-template-picker-status">
      <span>{currentTemplate ? `템플릿이 버전 ${currentTemplate.version}으로 변경됐습니다.` : '현재 템플릿을 다시 확인해 주세요.'}</span>
      {currentTemplate && <button type="button" className="btn" disabled={busy} onClick={acceptLatestTemplate}>최신 템플릿 사용</button>}
    </div>}
    <section className="document-templates-list" aria-label="저장한 템플릿">
      {catalog?.state === 'error' && <div className="document-template-picker-status">
        <span role="status">{catalog.message}</span><button className="btn" type="button" onClick={reload}>템플릿 다시 불러오기</button>
      </div>}
      {!catalog && <p role="status">템플릿을 불러오는 중…</p>}
      {catalog?.state === 'ready' && (templates.length ? <ul>{templates.map(template => <li key={template.id}>
        <button className="document-template-row" type="button" aria-label={template.name} aria-pressed={selected?.id === template.id}
          disabled={busy || recovering} onClick={() => choose(template)}>
          <FileStack size={16} aria-hidden="true" /><span><strong>{template.name}</strong><small>버전 {template.version}{template.archived ? ' · 보관' : ''}</small>
            <small>{template.sourceTitle} · 저장본 {template.sourceVersion}{(template.attachmentCount ?? 0) > 0 ? ` · 첨부 ${template.attachmentCount}개` : ''}</small></span>
        </button>
      </li>)}</ul> : <p>이 공간에 저장한 템플릿이 없습니다.</p>)}
    </section>
  </dialog>;
}
