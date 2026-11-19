'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Check, Download, File, History, ImageIcon, Loader2, Paperclip, Plus, RefreshCw, Trash2, UploadCloud, X } from 'lucide-react';
import type { Attachment, AttachmentVersion } from '../../shared/types';
import { api, remove } from '../lib/api';
import './attachments.css';

export type AttachmentsProps = {
  resourceType: 'issue' | 'document';
  resourceId: string;
  actorId: string;
  notify: (message: string, kind?: 'success' | 'error') => void;
  onInsertImage?: (url: string) => void;
  onChanged?: () => void | Promise<void>;
};

type Upload = {
  id: string;
  filename: string;
  percent: number;
  status: 'queued' | 'uploading' | 'done' | 'error';
  error?: string;
};

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const INLINE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const fileSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const fileUrl = (attachment: Attachment, inline = false) => `/api/attachments/${encodeURIComponent(attachment.id)}/content${inline ? '?inline=1' : ''}`;

export function Attachments(props: AttachmentsProps) { return <ResourceAttachments key={`${props.resourceType}:${props.resourceId}`} {...props} />; }
function ResourceAttachments({ resourceType, resourceId, actorId, notify, onInsertImage, onChanged }: AttachmentsProps) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [versionCache, setVersionCache] = useState<Record<string, AttachmentVersion[]>>({});
  const [versionAttachment, setVersionAttachment] = useState<string | null>(null), [versionLoading, setVersionLoading] = useState(false), [versionError, setVersionError] = useState(''), [versionOffset, setVersionOffset] = useState(0);
  const versionRequest = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const batchBusyRef = useRef(false);
  const generationRef = useRef(0);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const dragDepthRef = useRef(0);
  const queueCounterRef = useRef(0);
  const resourceRef = useRef(`${resourceType}:${resourceId}`);

  const load = useCallback(async (signal?: AbortSignal) => {
    const target = `${resourceType}:${resourceId}`;
    setLoading(true); setLoadError('');
    try {
      const result = await api<Attachment[]>(`/attachments?resourceType=${resourceType}&resourceId=${encodeURIComponent(resourceId)}`, { signal });
      if (mountedRef.current && resourceRef.current === target && !signal?.aborted) setAttachments(result);
    } catch (error) {
      if (mountedRef.current && resourceRef.current === target && !signal?.aborted) setLoadError(error instanceof Error ? error.message : '첨부파일을 불러오지 못했습니다.');
    } finally {
      if (mountedRef.current && resourceRef.current === target && !signal?.aborted) setLoading(false);
    }
  }, [resourceType, resourceId]);

  useEffect(() => {
    mountedRef.current = true;
    generationRef.current++;
    resourceRef.current = `${resourceType}:${resourceId}`;
    const controller = new AbortController();
    batchBusyRef.current = false;
    xhrRef.current = null;
    const initialLoad = setTimeout(() => void load(controller.signal), 0);
    return () => {
      mountedRef.current = false;
      clearTimeout(initialLoad);
      controller.abort();
      xhrRef.current?.abort();
      versionRequest.current?.abort();
    };
  }, [resourceType, resourceId, load]);

  function updateUpload(id: string, value: Partial<Upload>) {
    if (mountedRef.current) setUploads(previous => previous.map(item => item.id === id ? { ...item, ...value } : item));
  }

  async function refreshRelated() {
    try { await onChanged?.(); }
    catch { /* Refreshing activity must not turn an already saved file into an upload failure. */ }
  }

  function uploadFile(file: globalThis.File, id: string): Promise<Attachment> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhrRef.current = xhr;
      const query = new URLSearchParams({ resourceType, resourceId, filename: file.name });
      xhr.open('POST', `/api/attachments?${query}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-File-Type', file.type || 'application/octet-stream');
      if (actorId) xhr.setRequestHeader('X-Actor-Id', actorId);
      xhr.timeout = 120_000;
      xhr.upload.onprogress = event => {
        if (event.lengthComputable) updateUpload(id, { percent: Math.min(100, Math.round(event.loaded / event.total * 100)) });
      };
      xhr.onload = () => {
        let result: Attachment & { error?: string; message?: string };
        try { result = JSON.parse(xhr.responseText) as typeof result; }
        catch { reject(new Error('업로드 응답을 확인하지 못했습니다. 목록을 새로고침해주세요.')); return; }
        if (xhr.status >= 200 && xhr.status < 300 && result.id) resolve(result);
        else reject(new Error(result.error || result.message || `파일을 업로드하지 못했습니다. (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error('네트워크 연결을 확인한 후 다시 업로드해주세요.'));
      xhr.ontimeout = () => reject(new Error('업로드 시간이 초과되었습니다. 목록을 확인하고 다시 시도해주세요.'));
      xhr.onabort = () => reject(new Error('업로드를 취소했습니다.'));
      xhr.send(file);
    });
  }

  async function addFiles(files: FileList | globalThis.File[]) {
    if (!files.length || batchBusyRef.current) return;
    const candidates = Array.from(files);
    const batch = candidates.map(file => ({ id: `upload-${++queueCounterRef.current}`, filename: file.name, percent: 0, status: 'queued' as const }));
    setUploads(previous => [...previous.filter(item => item.status === 'error'), ...batch]);
    batchBusyRef.current = true; setUploading(true);
    const target = resourceRef.current;
    const generation = generationRef.current;
    let savedCount = 0;
    try {
      for (let index = 0; index < candidates.length; index++) {
        if (!mountedRef.current || resourceRef.current !== target || generation !== generationRef.current) break;
        const file = candidates[index];
        const item = batch[index];
        if (file.size > MAX_FILE_BYTES) { updateUpload(item.id, { status: 'error', error: '파일당 최대 20 MB까지 첨부할 수 있어요.' }); continue; }
        updateUpload(item.id, { status: 'uploading' });
        try {
          const result = await uploadFile(file, item.id);
          if (!mountedRef.current || resourceRef.current !== target || generation !== generationRef.current) break;
          setAttachments(previous => [...previous.filter(value => value.id !== result.id), result]);
          updateUpload(item.id, { status: 'done', percent: 100 });
          savedCount++;
        } catch (error) {
          updateUpload(item.id, { status: 'error', error: error instanceof Error ? error.message : '파일을 업로드하지 못했습니다.' });
        } finally { if (generation === generationRef.current) xhrRef.current = null; }
      }
    } finally {
      if (generation === generationRef.current) {
        batchBusyRef.current = false;
        if (mountedRef.current && resourceRef.current === target) { setUploading(false); void load(); if (savedCount) void refreshRelated(); }
        if (inputRef.current) inputRef.current.value = '';
      }
    }
  }

  async function deleteFile(attachment: Attachment) {
    if (deleting || !window.confirm(`“${attachment.filename}” 파일을 삭제할까요? 삽입한 이미지나 링크도 더 이상 열리지 않습니다.`)) return;
    setDeleting(attachment.id);
    try {
      await remove(`/attachments/${encodeURIComponent(attachment.id)}`);
      if (mountedRef.current) { setAttachments(previous => previous.filter(item => item.id !== attachment.id)); if (versionAttachment === attachment.id) { versionRequest.current?.abort(); setVersionAttachment(null); setVersionLoading(false); } notify('첨부파일을 삭제했습니다.', 'success'); void refreshRelated(); }
    } catch (error) { if (mountedRef.current) notify(error instanceof Error ? error.message : '첨부파일을 삭제하지 못했습니다.', 'error'); }
    finally { if (mountedRef.current) setDeleting(null); }
  }

  async function showVersions(attachment: Attachment, reload = false) {
    if (!reload && versionAttachment === attachment.id) { versionRequest.current?.abort(); setVersionAttachment(null); setVersionLoading(false); return; }
    versionRequest.current?.abort(); setVersionAttachment(attachment.id); setVersionOffset(0); setVersionError('');
    if (!reload && versionCache[attachment.id]) { setVersionLoading(false); return; }
    const controller = new AbortController(); versionRequest.current = controller; const generation = generationRef.current; setVersionLoading(true);
    try { const versions = await api<AttachmentVersion[]>(`/attachments/${encodeURIComponent(attachment.id)}/versions`, { signal: controller.signal }); if (!versions.length) throw new Error('확인할 수 있는 파일 버전이 없습니다. 다시 확인해 주세요.'); if (!controller.signal.aborted && mountedRef.current && generationRef.current === generation) { setVersionCache(previous => ({ ...previous, [attachment.id]: versions })); if (versions.length === 1 && !versions[0].sourceImportId) { setVersionAttachment(null); notify('이 파일은 현재 파일만 있으며 별도로 보존한 버전이 없습니다.'); } } }
    catch (error) { if (!controller.signal.aborted && mountedRef.current && generationRef.current === generation) setVersionError(error instanceof Error ? error.message : '보존 버전을 불러오지 못했습니다.'); }
    finally { if (!controller.signal.aborted && mountedRef.current && generationRef.current === generation) setVersionLoading(false); }
  }

  const activeUploads = uploads.filter(item => item.status !== 'done');

  return <section className="attachments-feature" aria-label="첨부파일">
    <div className="attachments-heading"><h3><Paperclip size={14} /> 첨부파일 <span>{attachments.length}</span></h3><button className="attachments-refresh" type="button" title="첨부파일 새로고침" aria-label="첨부파일 새로고침" disabled={loading || uploading} onClick={() => void load()}><RefreshCw size={12} className={loading ? 'attachments-spin' : ''} /></button></div>
    <div className={`attachments-dropzone ${dragging ? 'is-dragging' : ''} ${uploading ? 'is-busy' : ''}`}
      onDragEnter={event => { if (!event.dataTransfer.types.includes('Files')) return; event.preventDefault(); dragDepthRef.current++; setDragging(true); }}
      onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = uploading ? 'none' : 'copy'; } }}
      onDragLeave={event => { event.preventDefault(); dragDepthRef.current = Math.max(0, dragDepthRef.current - 1); if (!dragDepthRef.current) setDragging(false); }}
      onDrop={event => { event.preventDefault(); dragDepthRef.current = 0; setDragging(false); if (!uploading) void addFiles(event.dataTransfer.files); }}>
      <input ref={inputRef} type="file" multiple className="attachments-input" aria-label="첨부할 파일 선택" disabled={uploading} onChange={event => { if (event.target.files) void addFiles(event.target.files); }} />
      <UploadCloud size={20} /><p>{uploading ? '파일을 업로드하고 있어요' : '파일을 끌어놓거나 선택하세요'}</p><span>파일당 최대 20 MB</span><button className="btn btn-ghost" type="button" disabled={uploading} onClick={() => inputRef.current?.click()}><Plus size={12} /> 파일 선택</button>
    </div>

    {activeUploads.length > 0 && <div className="attachments-upload-list" aria-live="polite">{activeUploads.map(item => <div className={`attachments-upload ${item.status === 'error' ? 'has-error' : ''}`} key={item.id}><div><span>{item.filename}</span>{item.status === 'uploading' ? <span>{item.percent < 100 ? `${item.percent}%` : '저장 중…'}</span> : item.status === 'queued' ? <span>대기 중</span> : <button type="button" title="오류 닫기" aria-label={`${item.filename} 업로드 오류 닫기`} onClick={() => setUploads(previous => previous.filter(upload => upload.id !== item.id))}><X size={12} /></button>}</div>{item.status === 'uploading' && <div className="attachments-progress" role="progressbar" aria-label={`${item.filename} 업로드 진행률`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.percent}><span style={{ width: `${item.percent}%` }} /></div>}{item.error && <p role="alert">{item.error}</p>}</div>)}</div>}
    {loadError && <div className="attachments-error" role="alert"><p>{loadError}</p><button type="button" onClick={() => void load()}>다시 불러오기</button></div>}
    {loading && !attachments.length && <p className="attachments-empty"><Loader2 size={12} className="attachments-spin" /> 첨부파일을 불러오는 중…</p>}
    {!loading && !loadError && !attachments.length && <p className="attachments-empty">아직 첨부된 파일이 없어요.</p>}
    <div className="attachments-list">{attachments.map(attachment => {
      const image = INLINE_MIME_TYPES.has(attachment.mimeType);
      const versions = versionCache[attachment.id], hasHistory = versions && (versions.length > 1 || versions.some(version => version.sourceImportId));
      return <Fragment key={attachment.id}><article className="attachment-row">
        <div className={`attachment-symbol ${image ? 'is-image' : ''}`}>{image ? <ImageIcon size={17} /> : <File size={17} />}</div>
        <div className="attachment-description"><a href={fileUrl(attachment)} download={attachment.filename} title={attachment.filename}>{attachment.filename}</a><span>{fileSize(attachment.size)} · {new Date(attachment.createdAt).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })}</span>{image && onInsertImage && <button type="button" className="attachment-insert" onClick={() => onInsertImage(fileUrl(attachment, true))}><Plus size={10} /> 본문에 삽입</button>}</div>
        <a className="attachment-action" href={fileUrl(attachment)} download={attachment.filename} aria-label={`${attachment.filename} 다운로드`} title="다운로드"><Download size={13} /></a>
        {attachment.versionCount !== 0 && (!versions || hasHistory) && <button className="attachment-action" type="button" style={{ fontSize: '.875rem', gap: '.25rem', color: '#177c72' }} aria-label={`${attachment.filename} 버전`} aria-expanded={versionAttachment === attachment.id} onClick={() => void showVersions(attachment)}><History size={14} />버전</button>}
        <button className="attachment-action attachment-delete" type="button" aria-label={`${attachment.filename} 삭제`} title="삭제" disabled={Boolean(deleting)} onClick={() => void deleteFile(attachment)}>{deleting === attachment.id ? <Loader2 size={13} className="attachments-spin" /> : <Trash2 size={13} />}</button>
      </article>{versionAttachment === attachment.id && (versionLoading || versionError || hasHistory) && <section aria-label={`${attachment.filename} 보존 버전`} style={{ border: '1px solid #d3e3da', borderRadius: 7, padding: '1rem', margin: '.4rem 0 1rem', fontSize: '.875rem' }}><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '.5rem' }}><strong>보존한 파일 버전</strong><button className="btn btn-ghost" type="button" disabled={versionLoading} onClick={() => void showVersions(attachment, true)}>다시 확인</button></div>{versionLoading && <p role="status">버전 목록을 불러오는 중…</p>}{versionError && <p role="alert" style={{ color: '#953d40' }}>{versionError} 기존 목록은 유지됩니다.</p>}{hasHistory && <><ul style={{ listStyle: 'none', margin: '.5rem 0', padding: 0 }}>{versions.slice(versionOffset, versionOffset + 50).map(version => <li key={version.id} style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '.4rem', padding: '.65rem 0', borderBottom: '1px solid #e4ece7' }}><span><strong>{version.versionLabel}</strong><small style={{ display: 'block', fontSize: '.8125rem', color: '#51695c' }}>{version.sourceImportId ? '이관한 원본 버전' : '현재 파일'} · {fileSize(version.size)} · {new Date(version.createdAt).toLocaleString('ko-KR')}</small></span><a className="btn btn-ghost" href={`/api/attachment-versions/${encodeURIComponent(version.id)}/download`} download={version.filename} aria-label={`${attachment.filename} 버전 ${version.versionLabel} 다운로드`}><Download size={14} />다운로드</a></li>)}</ul>{versions.length > 50 && <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}><span>{versionOffset + 1}–{Math.min(versionOffset + 50, versions.length)} / {versions.length}</span><button className="btn btn-ghost" type="button" disabled={!versionOffset} onClick={() => setVersionOffset(Math.max(0, versionOffset - 50))}>이전 버전 페이지</button><button className="btn btn-ghost" type="button" disabled={versionOffset + 50 >= versions.length} onClick={() => setVersionOffset(versionOffset + 50)}>다음 버전 페이지</button></div>}</>}</section>}</Fragment>;
    })}</div>
    {!uploading && uploads.some(item => item.status === 'done') && <p className="attachments-success"><Check size={11} /> 파일을 첨부했습니다.</p>}
  </section>;
}
