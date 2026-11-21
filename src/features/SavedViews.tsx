'use client';

import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { BarChart3, Bookmark, Check, Link2, LoaderCircle, Pencil, Plus, Save, SquareChartGantt, Trash2, X } from 'lucide-react';
import type { PlanningItem, SavedView, SavedViewState, User } from '../../shared/types';
import { issuePriorityLabelFilterLabels } from '../../shared/issue-view';
import { api, patch, post, remove } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import { issuePlanningFilterLabels } from './issue-planning-filter-labels';
import { ISSUE_GITLAB_FILTER_LABELS } from './IssueGitlabSummary';
import { issueReporterFilterLabel } from './IssueReporterSelect';
import './saved-views.css';

type Props = {
  projectId: string;
  planningItems: readonly PlanningItem[];
  users: readonly User[];
  views: SavedView[];
  selectedId: string | null;
  current: SavedViewState;
  onSelect?: (id: string | null) => boolean;
  onApply: (view: SavedViewState) => void;
  onOpenGantt?: (viewId: string) => void;
  onOpenFieldBreakdown?: (viewId: string) => void;
  onViewsLoaded: (views: SavedView[]) => void;
  onViewsChanged: () => Promise<void>;
  notify: (message: string, kind?: 'success' | 'error') => void;
};
type ViewEditor = { mode: 'create'; state: SavedViewState } | { mode: 'update'; state: SavedViewState; target: SavedView };

function viewState({ layout, boardGrouping, filters }: SavedViewState): SavedViewState {
  return { layout, ...(layout === 'board' && boardGrouping ? { boardGrouping } : {}), filters };
}

export function SavedViews(props: Props) {
  return <ProjectSavedViews key={props.projectId} {...props}/>;
}

function ProjectSavedViews({projectId, planningItems, users, views, selectedId, current, onSelect, onApply, onOpenGantt, onOpenFieldBreakdown, onViewsLoaded, onViewsChanged, notify}: Props) {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [workspaceRefreshFailed, setWorkspaceRefreshFailed] = useState(false);
  const [editing, setEditing] = useState<ViewEditor | null>(null);
  const [name, setName] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [conflicted, setConflicted] = useState(false);
  const [copyFallback, setCopyFallback] = useState<{ id: string; href: string } | null>(null);
  const selected = views.find(view => view.id === selectedId);
  const copyInput = useRef<HTMLInputElement>(null);
  const copyRequest = useRef(0);
  const mounted = useRef(true);
  const navigationEpoch = useRef(0);
  const openViewRequest = useRef<symbol | null>(null);
  const submittedEditor = useRef<ViewEditor | null>(null);
  const savedEditor = useRef<ViewEditor | null>(null);
  const editorReload = useRef<Event | null>(null);
  const captureViewsPublisher = useEffectEvent(() => onViewsLoaded);
  const readEditor = useEffectEvent(() => {
    if (!editing || editing === savedEditor.current) return null;
    return { editing, dirty: name !== (editing.mode === 'update' ? editing.target.name : '') };
  });
  const notifyPending = useEffectEvent(() => notify('보기 저장이 끝난 뒤 이동해 주세요.', 'error'));
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    const onNavigate = (event: Event) => {
      if (event.defaultPrevented) return;
      const request = openViewRequest.current;
      const editor = readEditor();
      const reloading = editorReload.current === event;
      if (editor && !reloading) {
        if (editor.editing === submittedEditor.current) {
          event.preventDefault();
          notifyPending();
          return;
        }
        if (editor.dirty && !window.confirm('저장하지 않은 업무 보기 변경을 버리고 이동할까요?')) {
          event.preventDefault();
          return;
        }
      }
      afterAcceptedNavigation(event, () => {
        if (!mounted.current) return;
        navigationEpoch.current++;
        copyRequest.current++;
        setCopyFallback(null);
        if (editor && !reloading) setEditing(current => current === editor.editing ? null : current);
        if (request && openViewRequest.current === request) openViewRequest.current = null;
      });
    };
    const onUnload = (event: BeforeUnloadEvent) => {
      const editor = readEditor();
      if (editor && (editor.dirty || editor.editing === submittedEditor.current)) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('teamspace:navigate', onNavigate);
    window.addEventListener('beforeunload', onUnload);
    if (projectId && projectId !== 'all') {
      const publish = captureViewsPublisher();
      api<SavedView[]>(`/views?projectId=${encodeURIComponent(projectId)}`, {signal:controller.signal}).then(values => {
        if (!controller.signal.aborted) { publish(values); setError(''); }
      }).catch(cause => {
        if (!controller.signal.aborted) setError((cause as Error).message);
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    }
    return () => {
      mounted.current = false;
      controller.abort();
      openViewRequest.current = null;
      window.removeEventListener('teamspace:navigate', onNavigate);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [projectId]);
  useEffect(() => {
    if (!copyFallback || copyFallback.id !== selectedId) return;
    copyInput.current?.focus();
    copyInput.current?.select();
  }, [copyFallback, selectedId]);

  const openEditor = (mode: 'create' | 'update') => {
    if (mode === 'update' && !selected) return;
    const editor: ViewEditor = mode === 'update' && selected ? { mode, state: current, target: selected } : { mode: 'create', state: current };
    setName(editor.mode === 'update' ? editor.target.name : '');
    setDialogError('');setConflicted(false);setEditing(editor);
  };
  const reload = async () => {
    const list = await api<SavedView[]>(`/views?projectId=${encodeURIComponent(projectId)}`);
    if (mounted.current) {onViewsLoaded(list);setError('');}
  };
  const refreshWorkspace = async () => {
    try {
      await onViewsChanged();
      if (mounted.current) setWorkspaceRefreshFailed(false);
      return true;
    } catch {
      if (mounted.current) setWorkspaceRefreshFailed(true);
      return false;
    }
  };
  const retryWorkspace = async () => {
    if (busy) return;
    setBusy(true);
    await refreshWorkspace();
    if (mounted.current) setBusy(false);
  };
  const openSavedView = async (open: (viewId: string) => void) => {
    if (!selected || busy || openViewRequest.current) return;
    const request = Symbol('open saved view');
    const origin = window.location.hash;
    openViewRequest.current = request;
    setBusy(true);
    const ready = await refreshWorkspace();
    if (!mounted.current) return;
    setBusy(false);
    if (openViewRequest.current !== request) return;
    openViewRequest.current = null;
    if (ready && window.location.hash === origin) open(selected.id);
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();if (busy || !editing || submittedEditor.current) return;setBusy(true);setDialogError('');
    submittedEditor.current = editing;
    const origin = window.location.hash;
    const navigation = navigationEpoch.current;
    try {
      const value = editing.mode === 'update'
        ? await patch<SavedView>(`/views/${encodeURIComponent(editing.target.id)}`, {
          name, ...editing.state, boardGrouping: editing.state.boardGrouping ?? null, filters: {
            ...editing.state.filters, planning: editing.state.filters.planning ?? {}, gitlab: editing.state.filters.gitlab ?? null,
            priorities: editing.state.filters.priorities ?? [], labels: editing.state.filters.labels ?? {},
            reporter: editing.state.filters.reporter ?? null,
          }, expectedVersion: editing.target.version,
        })
        : await post<SavedView>('/views', {projectId, name, ...editing.state});
      savedEditor.current = editing;
      if (mounted.current) {
        onViewsLoaded([...views.filter(view => view.id !== value.id), value].sort((a,b) => a.name.localeCompare(b.name,'ko')));
        setEditing(null);setError('');notify('업무 보기를 저장했습니다.');
      }
      await refreshWorkspace();
      if (editing.mode === 'create' && mounted.current && origin === window.location.hash && navigation === navigationEpoch.current) onSelect?.(value.id);
    } catch (error) {
      if (mounted.current) {setDialogError((error as Error).message);setConflicted(editing.mode === 'update' && (error as {status?:number}).status === 409);}
    } finally {
      submittedEditor.current = null;
      if (mounted.current) setBusy(false);
    }
  };
  const deleteView = async () => {
    if (busy || !selected || !window.confirm(`“${selected.name}” 보기를 삭제할까요? 업무 데이터는 유지됩니다.`)) return;
    setBusy(true);
    const origin = window.location.hash;
    const navigation = navigationEpoch.current;
    try {
      await remove(`/views/${encodeURIComponent(selected.id)}?expectedVersion=${selected.version}`);
      if (mounted.current) {
        onViewsLoaded(views.filter(view => view.id !== selected.id));
        if (origin === window.location.hash && navigation === navigationEpoch.current) onSelect?.(null);
        notify('저장된 보기를 삭제했습니다.');
      }
      await refreshWorkspace();
    } catch (error) {
      if (mounted.current) {notify((error as Error).message,'error');await reload().catch(() => {});}
    } finally {if (mounted.current) setBusy(false);}
  };
  const copyViewLink = async (value: SavedView) => {
    const query = new URLSearchParams({ savedView: value.id });
    const address = new URL(window.location.href);
    address.search = '';
    address.hash = `/${encodeURIComponent(projectId)}/issues?${query}`;
    const href = address.href;
    const request = ++copyRequest.current;
    setCopyFallback(null);
    try {
      await navigator.clipboard.writeText(href);
      if (mounted.current && copyRequest.current === request) notify('보기 링크를 복사했습니다.');
    } catch {
      if (mounted.current && copyRequest.current === request) setCopyFallback({ id: value.id, href });
    }
  };
  const reapplySelected = () => {
    if (selected && window.dispatchEvent(new Event('teamspace:navigate', {cancelable:true}))) onApply(selected);
  };
  const reloadConflicted = async () => {
    if (editing?.mode !== 'update') return;
    if (!window.confirm('입력한 보기 이름을 버리고 최신 보기 설정을 적용할까요?')) return;
    const confirmation = new Event('teamspace:navigate', {cancelable:true});
    editorReload.current = confirmation;
    const accepted = window.dispatchEvent(confirmation);
    editorReload.current = null;
    if (!accepted) return;
    const origin = window.location.hash;
    // The guard records accepted navigation after the complete event dispatch.
    await Promise.resolve();
    const navigation = navigationEpoch.current;
    setBusy(true);
    try {
      const list = await api<SavedView[]>(`/views?projectId=${encodeURIComponent(projectId)}`);
      if (!mounted.current) return;
      onViewsLoaded(list);
      if (origin !== window.location.hash || navigation !== navigationEpoch.current) {setEditing(null);return;}
      const latest = list.find(view => view.id === editing.target.id);
      if (!latest) {savedEditor.current = editing;onSelect?.(null);setEditing(null);notify('이 보기는 삭제되었습니다.','error');return;}
      setEditing({ mode: 'update', state: viewState(latest), target: latest });
      setName(latest.name);onApply(latest);setConflicted(false);setDialogError('');
    } catch (cause) {
      if (mounted.current) setDialogError((cause as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const changed = selected && JSON.stringify(viewState(selected)) !== JSON.stringify(viewState(current));
  const editorState = editing?.state;
  if (!projectId || projectId === 'all') return null;
  return <div className="saved-views">
    <div className="saved-views-picker"><Bookmark size={15}/><select aria-label="저장된 업무 보기" disabled={loading || busy} value={selectedId ?? ''} onChange={event => {
      const id = event.target.value || null;
      if (id === selectedId) reapplySelected();
      else if (onSelect?.(id)) setCopyFallback(null);
    }}><option value="">{loading ? '보기를 불러오는 중…' : '저장된 보기 선택'}</option>{selectedId && !selected && <option value={selectedId}>열 수 없는 공유 보기</option>}{views.map(view => <option key={view.id} value={view.id}>{view.name}</option>)}</select></div>
    {selectedId && !selected && <div className="saved-view-error" role="status">
      <span>이 프로젝트에서 공유 보기를 열 수 없습니다.</span>
      <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => onSelect?.(null)}>공유 보기 해제</button>
    </div>}
    {selected && <>
      <span className="saved-view-indicator">{changed ? '조건이 변경됨' : <><Check size={12}/> 저장된 조건</>}</span>
      {changed && <button className="btn btn-ghost" type="button" disabled={busy} onClick={reapplySelected}>저장된 조건 다시 적용</button>}
      {onOpenGantt && <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => void openSavedView(onOpenGantt)}
        title="선택한 보기의 저장된 조건을 적용합니다."><SquareChartGantt size={14} aria-hidden="true" /> 간트에서 열기</button>}
      {onOpenFieldBreakdown && <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => void openSavedView(onOpenFieldBreakdown)}
        title="선택한 보기의 저장된 조건으로 집계 범위를 지정합니다."><BarChart3 size={14} aria-hidden="true" /> 필드 집계에서 열기</button>}
      <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => void copyViewLink(selected)}
        title="저장된 조건을 여는 주소를 복사합니다."><Link2 size={14} aria-hidden="true" />보기 링크 복사</button>
      <button className="btn btn-ghost" disabled={busy} onClick={() => openEditor('update')} title="현재 조건으로 보기 수정"><Pencil size={13}/> 보기 수정</button>
      <button className="icon-btn" disabled={busy} onClick={deleteView} aria-label="선택한 보기 삭제"><Trash2 size={14}/></button>
    </>}
    {copyFallback && copyFallback.id === selected?.id && <label className="saved-view-copy-fallback">
      보기 링크 주소<input ref={copyInput} className="field" readOnly value={copyFallback.href} onFocus={event => event.currentTarget.select()} />
    </label>}
    <button className="btn btn-ghost saved-view-create" disabled={loading || busy} onClick={() => openEditor('create')}><Plus size={13}/> 현재 보기 저장</button>
    {error && <span className="saved-view-error" role="alert">{error}<button className="text-link" onClick={() => reload().catch(e => notify(e.message,'error'))}>다시 불러오기</button></span>}
    {workspaceRefreshFailed && <div className="saved-view-error" role="status"><span>작업 공간의 보기 목록을 갱신하지 못했습니다.</span>
      <button className="text-link" type="button" disabled={busy} onClick={() => void retryWorkspace()}>작업 공간 다시 불러오기</button>
    </div>}
    {editing && editorState && <div className="modal-backdrop"><form className="modal-card saved-view-dialog" role="dialog" aria-modal="true" aria-labelledby="saved-view-title" onSubmit={save}>
      <div className="card-heading"><h2 id="saved-view-title">{editing.mode === 'create' ? '업무 보기 저장' : '저장된 보기 수정'}</h2><button type="button" className="icon-btn" disabled={busy} onClick={() => setEditing(null)} aria-label="보기 저장 닫기"><X size={18}/></button></div>
      <p className="muted">적용된 검색어와 필터를 {editorState.layout === 'board' ? '보드' : '목록'} 보기로 저장해 프로젝트에서 공유합니다.</p>
      <label className="form-label">보기 이름<input autoFocus className="field" aria-label="보기 이름" value={name} onChange={event => setName(event.target.value)} disabled={busy} required maxLength={80} placeholder="예: 이번 주 검토할 업무"/></label>
      <div className="saved-view-definition"><span>{editorState.layout === 'board' ? '보드' : '목록'}</span>{editorState.boardGrouping === 'assignee' && <span>담당자별</span>}<span>{editorState.filters.status === 'all' ? '모든 상태' : `상태: ${editorState.filters.status}`}</span>{editorState.filters.query && <span>검색: {editorState.filters.query}</span>}{editorState.filters.type !== 'all' && <span>유형: {editorState.filters.type}</span>}{editorState.filters.fieldFilter && <span>사용자 정의 필드 {editorState.filters.fieldFilter.rules.length}개</span>}
        {issuePlanningFilterLabels(editorState.filters.planning, planningItems).map(label => <span key={label}>{label}</span>)}
        {editorState.filters.reporter && <span>{issueReporterFilterLabel(editorState.filters.reporter, users)}</span>}
        {editorState.filters.gitlab && <span>{ISSUE_GITLAB_FILTER_LABELS[editorState.filters.gitlab]}</span>}
        {issuePriorityLabelFilterLabels(editorState.filters).map(label => <span key={label}>{label}</span>)}
      </div>
      {dialogError && <p className="error-text" role="alert">{dialogError}</p>}
      {conflicted && <button type="button" className="btn" disabled={busy} onClick={() => void reloadConflicted()}>최신 보기 불러오기</button>}
      <div className="modal-actions"><button type="button" className="btn" disabled={busy} onClick={() => setEditing(null)}>취소</button><button className="btn btn-primary" disabled={busy || conflicted || !name.trim()}>{busy ? <LoaderCircle size={14} className="spin"/> : <Save size={14}/>} 저장</button></div>
    </form></div>}
  </div>;
}
