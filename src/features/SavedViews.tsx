'use client';

import { useEffect, useRef, useState } from 'react';
import { Bookmark, Check, LoaderCircle, Pencil, Plus, Save, Trash2, X } from 'lucide-react';
import type { SavedView, SavedViewState } from '../../shared/types';
import { api, patch, post, remove } from '../lib/api';
import './saved-views.css';

type Props = {
  projectId: string;
  actorId: string;
  current: SavedViewState;
  onApply: (view: SavedViewState) => void;
  notify: (message: string, kind?: 'success' | 'error') => void;
};

export function SavedViews(props: Props) {
  return <ProjectSavedViews key={props.projectId} {...props}/>;
}

function ProjectSavedViews({projectId, current, onApply, notify}: Props) {
  const [views, setViews] = useState<SavedView[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<'create' | 'update' | null>(null);
  const [name, setName] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [conflicted, setConflicted] = useState(false);
  const selected = views.find(view => view.id === selectedId);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    api<SavedView[]>(`/views?projectId=${encodeURIComponent(projectId)}`, {signal:controller.signal}).then(value => {
      if (mounted.current) {setViews(value);setError('');}
    }).catch(error => {if (!controller.signal.aborted && mounted.current) setError(error.message);}).finally(() => {
      if (mounted.current) setLoading(false);
    });
    return () => {mounted.current = false;controller.abort();};
  }, [projectId]);

  const openEditor = (mode: 'create' | 'update') => {
    setName(mode === 'update' ? selected?.name || '' : '');
    setDialogError('');setConflicted(false);setEditing(mode);
  };
  const reload = async () => {
    const list = await api<SavedView[]>(`/views?projectId=${encodeURIComponent(projectId)}`);
    if (mounted.current) {setViews(list);setError('');}
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();setBusy(true);setDialogError('');
    try {
      const value = editing === 'update' && selected ? await patch<SavedView>(`/views/${selected.id}`, {name,...current,expectedVersion:selected.version}) : await post<SavedView>('/views', {projectId,name,...current});
      if (mounted.current) {setViews(previous => [...previous.filter(view => view.id !== value.id), value].sort((a,b) => a.name.localeCompare(b.name,'ko')));setSelectedId(value.id);setEditing(null);setError('');notify('업무 보기를 저장했습니다.');}
    } catch (error) {
      if (mounted.current) {setDialogError((error as Error).message);setConflicted(editing === 'update' && (error as {status?:number}).status === 409);}
    } finally {if (mounted.current) setBusy(false);}
  };
  const deleteView = async () => {
    if (!selected || !window.confirm(`“${selected.name}” 보기를 삭제할까요? 업무 데이터는 유지됩니다.`)) return;
    setBusy(true);
    try {await remove(`/views/${selected.id}?expectedVersion=${selected.version}`);if (mounted.current) {setViews(previous => previous.filter(view => view.id !== selected.id));setSelectedId('');notify('저장된 보기를 삭제했습니다.');}}
    catch (error) {notify((error as Error).message,'error');await reload().catch(() => {});}
    finally {setBusy(false);}
  };
  const changed = selected && JSON.stringify({layout:selected.layout,filters:selected.filters}) !== JSON.stringify(current);
  if (!projectId || projectId === 'all') return null;
  return <div className="saved-views">
    <div className="saved-views-picker"><Bookmark size={15}/><select aria-label="저장된 업무 보기" disabled={loading || busy} value={selectedId} onChange={event => {
      const next = views.find(view => view.id === event.target.value);
      setSelectedId(event.target.value);
      if (next) onApply(next);
    }}><option value="">{loading ? '보기를 불러오는 중…' : '저장된 보기 선택'}</option>{views.map(view => <option key={view.id} value={view.id}>{view.name}</option>)}</select></div>
    {selected && <><span className="saved-view-indicator">{changed ? '조건이 변경됨' : <><Check size={12}/> 저장된 조건</>}</span><button className="btn btn-ghost" disabled={busy} onClick={() => openEditor('update')} title="현재 조건으로 보기 수정"><Pencil size={13}/> 보기 수정</button><button className="icon-btn" disabled={busy} onClick={deleteView} aria-label="선택한 보기 삭제"><Trash2 size={14}/></button></>}
    <button className="btn btn-ghost saved-view-create" disabled={loading || busy} onClick={() => openEditor('create')}><Plus size={13}/> 현재 보기 저장</button>
    {error && <span className="saved-view-error" role="alert">{error}<button className="text-link" onClick={() => reload().catch(e => notify(e.message,'error'))}>다시 불러오기</button></span>}
    {editing && <div className="modal-backdrop"><form className="modal-card saved-view-dialog" role="dialog" aria-modal="true" aria-labelledby="saved-view-title" onSubmit={save}>
      <div className="card-heading"><h2 id="saved-view-title">{editing === 'create' ? '업무 보기 저장' : '저장된 보기 수정'}</h2><button type="button" className="icon-btn" disabled={busy} onClick={() => setEditing(null)} aria-label="보기 저장 닫기"><X size={18}/></button></div>
      <p className="muted">현재 검색어·상태·담당자·유형 필터와 {current.layout === 'board' ? '보드' : '목록'} 화면을 프로젝트의 공유 보기로 저장합니다.</p>
      <label className="form-label">보기 이름<input autoFocus className="field" aria-label="보기 이름" value={name} onChange={event => setName(event.target.value)} disabled={busy} required maxLength={80} placeholder="예: 이번 주 검토할 업무"/></label>
      <div className="saved-view-definition"><span>{current.layout === 'board' ? '보드' : '목록'}</span><span>{current.filters.status === 'all' ? '모든 상태' : `상태: ${current.filters.status}`}</span>{current.filters.query && <span>검색: {current.filters.query}</span>}{current.filters.type !== 'all' && <span>유형: {current.filters.type}</span>}</div>
      {dialogError && <p className="error-text" role="alert">{dialogError}</p>}
      {conflicted && <button type="button" className="btn" disabled={busy} onClick={async () => {
        if (!window.confirm('입력한 보기 이름을 버리고 최신 보기 설정을 적용할까요?')) return;
        setBusy(true);
        try {const list = await api<SavedView[]>(`/views?projectId=${encodeURIComponent(projectId)}`);if (!mounted.current) return;setViews(list);const latest = list.find(view => view.id === selectedId);if (!latest) {setSelectedId('');setEditing(null);notify('이 보기는 삭제되었습니다.','error');return;}setName(latest.name);onApply(latest);setConflicted(false);setDialogError('');}
        catch (error) {if (mounted.current) setDialogError((error as Error).message);}
        finally {if (mounted.current) setBusy(false);}
      }}>최신 보기 불러오기</button>}
      <div className="modal-actions"><button type="button" className="btn" disabled={busy} onClick={() => setEditing(null)}>취소</button><button className="btn btn-primary" disabled={busy || conflicted || !name.trim()}>{busy ? <LoaderCircle size={14} className="spin"/> : <Save size={14}/>} 저장</button></div>
    </form></div>}
  </div>;
}
