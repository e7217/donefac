'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Bookmark, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import type { FeatureProps, IssueFieldBreakdownQuery, SavedFieldBreakdown } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { afterAcceptedNavigation, isReportPreservedByNavigation } from '../lib/navigation';
import './field-breakdown-presets.css';

type Props = Pick<FeatureProps, 'projectId' | 'actorId' | 'notify'> & {
  currentQuery: IssueFieldBreakdownQuery | null;
  reportBusy: boolean;
  describeQuery: (query: IssueFieldBreakdownQuery) => string;
  onOpen: (preset: SavedFieldBreakdown) => void;
};
type Editor = { name: string; preset?: SavedFieldBreakdown; query?: IssueFieldBreakdownQuery };

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '저장한 필드 집계 요청을 처리하지 못했습니다.';
}

const sortPresets = (presets: SavedFieldBreakdown[]) => presets.sort((a, b) => a.name.localeCompare(b.name, 'ko') || a.id.localeCompare(b.id));

export function FieldBreakdownPresets({ projectId, actorId, currentQuery, reportBusy, describeQuery, onOpen, notify }: Props) {
  const id = useId();
  const [presets, setPresets] = useState<SavedFieldBreakdown[] | null>(null);
  const [listError, setListError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const reloadButton = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listRequest = useRef<AbortController | null>(null);
  const writeRequest = useRef<AbortController | null>(null);
  const dirty = Boolean(editor && (editor.name !== (editor.preset?.name ?? '') || editor.preset && editor.query));
  const editorOpen = editor !== null;
  const path = `/projects/${encodeURIComponent(projectId)}/field-breakdown-presets`;
  const headers = { 'X-Actor-Id': actorId };
  const editingPreset = editor?.preset;
  const latest = editingPreset && presets?.find(item => item.id === editingPreset.id);
  const versionChanged = Boolean(latest && latest.version !== editingPreset?.version);
  const editorMissing = Boolean(editingPreset && presets && !latest);
  const canSave = Boolean(dirty && editor?.name.trim() && actorId && !busy && !refreshRequired && !versionChanged && !editorMissing && (editingPreset || editor.query));

  const reload = useCallback(async () => {
    listRequest.current?.abort();
    const controller = new AbortController();
    listRequest.current = controller;
    setLoading(true);
    setListError('');
    try {
      const items = await api<SavedFieldBreakdown[]>(path, { cache: 'no-store', headers: { 'X-Actor-Id': actorId }, signal: controller.signal });
      if (!controller.signal.aborted) {
        setPresets(sortPresets(items));
        setRefreshRequired(false);
      }
    } catch (error) {
      if (!controller.signal.aborted) setListError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [path, actorId]);

  useEffect(() => {
    const imported = () => {
      writeRequest.current?.abort();
      writeRequest.current = null;
      setBusy(false);
      void reload();
    };
    const timer = window.setTimeout(() => void reload(), 0);
    window.addEventListener('donefac:workspace-imported', imported);
    return () => {
      window.removeEventListener('donefac:workspace-imported', imported);
      window.clearTimeout(timer);
      listRequest.current?.abort();
      writeRequest.current?.abort();
    };
  }, [reload]);

  useEffect(() => {
    const navigate = (event: Event) => {
      if (event.defaultPrevented || isReportPreservedByNavigation(event)) return;
      if (writeRequest.current) {
        event.preventDefault();
        notify('저장한 집계의 변경 결과를 확인한 뒤 이동해 주세요.', 'error');
      } else if (editorOpen) {
        if (dirty && !window.confirm('입력 중인 저장 집계 변경을 버리고 이동할까요?')) event.preventDefault();
        else afterAcceptedNavigation(event, () => { setEditor(null); setActionError(''); });
      }
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (!dirty && !writeRequest.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('donefac:navigate', navigate);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('donefac:navigate', navigate);
      window.removeEventListener('beforeunload', unload);
    };
  }, [dirty, editorOpen, notify]);

  function beginEdit(button: HTMLButtonElement, preset?: SavedFieldBreakdown) {
    if (!preset && !currentQuery) return;
    opener.current = button;
    setEditor({ name: preset?.name ?? '', preset, query: preset ? undefined : currentQuery ?? undefined });
    setActionError('');
    requestAnimationFrame(() => input.current?.focus());
  }

  function closeEditor() {
    setEditor(null);
    setActionError('');
    requestAnimationFrame(() => (opener.current?.isConnected && !opener.current.disabled ? opener.current : reloadButton.current)?.focus());
  }

  async function mutate(action: (signal: AbortSignal) => Promise<void>) {
    if (writeRequest.current || loading) return;
    const controller = new AbortController();
    writeRequest.current = controller;
    setBusy(true);
    setActionError('');
    try {
      await action(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return;
      setActionError(errorMessage(error));
      if (error instanceof ApiError && (error.status === 404 || error.status === 409)) {
        setRefreshRequired(true);
        await reload();
      }
    } finally {
      if (!controller.signal.aborted) {
        writeRequest.current = null;
        setBusy(false);
      }
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!editor || !canSave) return;
    const existing = editor.preset;
    const payload = { name: editor.name.trim(), ...(existing ? { expectedVersion: existing.version } : {}), ...(editor.query ? { query: editor.query } : {}) };
    void mutate(async signal => {
      const saved = await api<SavedFieldBreakdown>(existing ? `${path}/${encodeURIComponent(existing.id)}` : path, {
        method: existing ? 'PATCH' : 'POST', headers, signal, body: JSON.stringify(payload),
      });
      if (signal.aborted) return;
      setPresets(previous => sortPresets([...(previous ?? []).filter(item => item.id !== saved.id), saved]));
      closeEditor();
      notify(existing ? '저장한 집계를 변경했습니다.' : '필드 집계를 저장했습니다.');
    });
  }

  function deletePreset(preset: SavedFieldBreakdown) {
    if (!window.confirm(`“${preset.name}” 집계를 삭제할까요?`)) return;
    void mutate(async signal => {
      await api<{ ok: true }>(`${path}/${encodeURIComponent(preset.id)}?expectedVersion=${preset.version}`, { method: 'DELETE', headers, signal });
      if (signal.aborted) return;
      setPresets(previous => (previous ?? []).filter(item => item.id !== preset.id));
      requestAnimationFrame(() => reloadButton.current?.focus());
      notify('저장한 집계를 삭제했습니다.');
    });
  }

  const locked = busy || loading || refreshRequired || !actorId;
  return <section className="card field-breakdown-presets" aria-labelledby={`${id}-title`}>
    <header className="field-breakdown-presets-header">
      <div>
        <h2 id={`${id}-title`}><Bookmark size={19} aria-hidden="true" />저장한 필드 집계</h2>
        <p>프로젝트 팀원이 저장한 조건을 열어 최신 업무를 조회할 수 있습니다.</p>
      </div>
      <div className="field-breakdown-presets-actions">
        <button type="button" ref={reloadButton} className="btn btn-ghost" aria-label="저장한 필드 집계 새로고침"
          disabled={busy || loading} onClick={() => void reload()}><RefreshCw size={15} aria-hidden="true" />새로고침</button>
        <button type="button" className="btn" disabled={locked || !currentQuery || Boolean(editor)}
          onClick={event => beginEdit(event.currentTarget)}><Bookmark size={15} aria-hidden="true" />현재 집계 저장</button>
      </div>
    </header>
    {loading && !presets && <p className="field-breakdown-presets-meta" role="status">저장한 집계를 불러오는 중…</p>}
    {!loading && presets?.length === 0 && <p className="field-breakdown-presets-meta">저장한 집계가 없습니다.</p>}
    {listError && <p className="field-breakdown-error" role="alert">{listError}</p>}
    {presets && presets.length > 0 && <ul className="field-breakdown-presets-list">
      {presets.map(preset => <li key={preset.id}>
        <div className="field-breakdown-presets-row-copy">
          <button type="button" className="text-link" aria-label={`집계 열기: ${preset.name}`}
            disabled={busy || loading || reportBusy || Boolean(editor)} onClick={() => onOpen(preset)}>
            <strong>{preset.name}</strong><ArrowRight size={14} aria-hidden="true" />
          </button>
          <p className="field-breakdown-presets-meta">{describeQuery(preset.query)}</p>
        </div>
        <div className="field-breakdown-presets-actions">
          <button type="button" className="btn btn-ghost" aria-label={`집계 편집: ${preset.name}`} disabled={locked || Boolean(editor)}
            onClick={event => beginEdit(event.currentTarget, preset)}><Pencil size={15} aria-hidden="true" />편집</button>
          <button type="button" className="btn btn-ghost" aria-label={`집계 삭제: ${preset.name}`} disabled={locked || Boolean(editor)}
            onClick={() => deletePreset(preset)}><Trash2 size={15} aria-hidden="true" />삭제</button>
        </div>
      </li>)}
    </ul>}
    {editor && <form className="field-breakdown-presets-editor" aria-label={editor.preset ? '저장한 집계 편집' : '현재 집계 이름 저장'} onSubmit={submit}
      onKeyDown={event => { if (event.key === 'Escape' && !writeRequest.current) { event.preventDefault(); closeEditor(); } }}>
      <label className="field-breakdown-presets-editor-name">집계 이름
        <input ref={input} className="field" value={editor.name} maxLength={80} required disabled={busy}
          onChange={event => setEditor({ ...editor, name: event.currentTarget.value })} />
      </label>
      {editor.preset && <label className="field-breakdown-presets-editor-option">
        <input type="checkbox" checked={Boolean(editor.query)} disabled={busy || (!currentQuery && !editor.query)}
          onChange={event => setEditor({ ...editor, query: event.currentTarget.checked ? currentQuery ?? undefined : undefined })} />현재 조회 조건으로 바꾸기
      </label>}
      {editor.query && <p className="field-breakdown-presets-meta">{describeQuery(editor.query)}</p>}
      {versionChanged && latest && <div className="field-breakdown-presets-rebase">
        <p className="field-breakdown-info">다른 작업자가 이 집계를 변경했습니다. 입력을 유지하며 최신 버전에서 편집할 수 있습니다.</p>
        <button type="button" className="btn" disabled={busy || loading} onClick={() => {
          setEditor({ ...editor, preset: latest });
          setActionError('');
          input.current?.focus();
        }}>최신 버전으로 다시 편집</button>
      </div>}
      {editorMissing && <p className="field-breakdown-info">편집 중인 집계를 현재 목록에서 찾을 수 없습니다. 입력은 유지됩니다.</p>}
      <div className="field-breakdown-presets-actions">
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={closeEditor}>취소</button>
        <button type="submit" className="btn btn-primary" disabled={!canSave || loading}>저장</button>
      </div>
    </form>}
    {actionError && <p className="field-breakdown-error" role="alert">{actionError}</p>}
  </section>;
}
