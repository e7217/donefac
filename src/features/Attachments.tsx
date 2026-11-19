'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Check, Download, File, History, ImageIcon, Loader2, Paperclip, Plus, RefreshCw, Trash2, UploadCloud, X } from 'lucide-react';
import type { AttachmentHead, AttachmentVersion } from '../../shared/types';
import { api, ApiError, remove } from '../lib/api';
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
  isVersion: boolean;
  error?: string;
};

type VersionPanel = {
  attachmentId: string;
  versions: AttachmentVersion[];
  loading: boolean;
  error: string;
  offset: number;
};

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const VERSIONS_PER_PAGE = 50;
const INLINE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const fileSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const fileUrl = (versionId: string, inline = false) => `/api/attachments/${encodeURIComponent(versionId)}/content${inline ? '?inline=1' : ''}`;
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

export function Attachments(props: AttachmentsProps) { return <ResourceAttachments key={`${props.resourceType}:${props.resourceId}:${props.actorId}`} {...props} />; }
function ResourceAttachments({ resourceType, resourceId, actorId, notify, onInsertImage, onChanged }: AttachmentsProps) {
  const [attachments, setAttachments] = useState<AttachmentHead[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [versions, setVersions] = useState<VersionPanel | null>(null);
  const listRequest = useRef<AbortController | null>(null);
  const versionRequest = useRef<AbortController | null>(null);
  const versionCache = useRef(new Map<string, AttachmentVersion[]>());
  const inputRef = useRef<HTMLInputElement>(null);
  const versionInputRef = useRef<HTMLInputElement>(null);
  const pickedAttachment = useRef<AttachmentHead | null>(null);
  const mountedRef = useRef(true);
  const batchBusyRef = useRef(false);
  const generationRef = useRef(0);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const dragDepthRef = useRef(0);
  const queueCounterRef = useRef(0);

  const load = useCallback(async () => {
    listRequest.current?.abort();
    const controller = new AbortController();
    listRequest.current = controller;
    setLoading(true); setLoadError('');
    try {
      const result = await api<AttachmentHead[]>(`/attachments?resourceType=${resourceType}&resourceId=${encodeURIComponent(resourceId)}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setAttachments(result);
      return result;
    } catch (error) {
      if (!controller.signal.aborted) setLoadError(message(error, '첨부파일을 불러오지 못했습니다.'));
    } finally {
      if (listRequest.current === controller) listRequest.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [resourceType, resourceId]);

  useEffect(() => {
    mountedRef.current = true;
    generationRef.current++;
    batchBusyRef.current = false;
    xhrRef.current = null;
    const initialLoad = setTimeout(() => void load(), 0);
    return () => {
      mountedRef.current = false;
      clearTimeout(initialLoad);
      listRequest.current?.abort();
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

  function uploadFile(file: globalThis.File, id: string, attachment?: AttachmentHead): Promise<AttachmentHead> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhrRef.current = xhr;
      const query = new URLSearchParams({ filename: file.name });
      if (attachment) query.set('expectedVersionId', attachment.currentVersionId);
      else {
        query.set('resourceType', resourceType);
        query.set('resourceId', resourceId);
      }
      const path = attachment ? `/api/attachments/${encodeURIComponent(attachment.id)}/versions` : '/api/attachments';
      xhr.open('POST', `${path}?${query}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-File-Type', file.type || 'application/octet-stream');
      if (actorId) xhr.setRequestHeader('X-Actor-Id', actorId);
      xhr.timeout = 120_000;
      xhr.upload.onprogress = event => {
        if (event.lengthComputable) updateUpload(id, { percent: Math.min(100, Math.round(event.loaded / event.total * 100)) });
      };
      xhr.onload = () => {
        let result: AttachmentHead & { error?: string; message?: string };
        try { result = JSON.parse(xhr.responseText) as typeof result; }
        catch { reject(new Error('업로드 응답을 확인하지 못했습니다. 목록을 새로고침해주세요.')); return; }
        if (xhr.status >= 200 && xhr.status < 300 && result?.id && result.currentVersionId) resolve(result);
        else reject(new ApiError(xhr.status, result?.error || result?.message || `파일을 업로드하지 못했습니다. (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error('네트워크 연결을 확인한 후 다시 업로드해주세요.'));
      xhr.ontimeout = () => reject(new Error('업로드 시간이 초과되었습니다. 목록을 확인하고 다시 시도해주세요.'));
      xhr.onabort = () => reject(new Error('업로드를 취소했습니다.'));
      xhr.send(file);
    });
  }

  async function addFiles(files: FileList | globalThis.File[], attachment?: AttachmentHead) {
    if (!files.length || batchBusyRef.current || deleting) return;
    const candidates = Array.from(files);
    const batch = candidates.map(file => ({
      id: `upload-${++queueCounterRef.current}`, filename: file.name, percent: 0,
      status: 'queued' as const, isVersion: Boolean(attachment),
    }));
    setUploads(previous => [...previous.filter(item => item.status === 'error'), ...batch]);
    batchBusyRef.current = true; setUploading(true);
    const generation = generationRef.current;
    const isActive = () => mountedRef.current && generation === generationRef.current;
    let savedCount = 0;
    try {
      for (let index = 0; index < candidates.length; index++) {
        if (!isActive()) break;
        const file = candidates[index];
        const item = batch[index];
        if (file.size > MAX_FILE_BYTES) { updateUpload(item.id, { status: 'error', error: '파일당 최대 20 MB까지 첨부할 수 있어요.' }); continue; }
        updateUpload(item.id, { status: 'uploading' });
        try {
          const result = await uploadFile(file, item.id, attachment);
          if (!isActive()) break;
          setAttachments(previous => attachment
            ? previous.map(value => value.id === result.id ? result : value)
            : [...previous, result]);
          updateUpload(item.id, { status: 'done', percent: 100 });
          savedCount++;
        } catch (error) {
          if (isActive()) updateUpload(item.id, { status: 'error', error: message(error, '파일을 업로드하지 못했습니다.') });
        } finally { if (isActive()) xhrRef.current = null; }
      }
    } finally {
      if (isActive()) {
        const rows = await load();
        const hasHistory = rows ? rows.some(row => row.id === attachment?.id && row.hasVersionHistory)
          : Boolean(savedCount || attachment?.hasVersionHistory);
        if (isActive() && attachment && hasHistory) {
          await loadVersions(attachment.id);
        }
      }
      if (isActive()) {
        batchBusyRef.current = false;
        setUploading(false);
        if (savedCount) void refreshRelated();
        if (inputRef.current) inputRef.current.value = '';
      }
    }
  }

  async function deleteFile(attachment: AttachmentHead) {
    if (deleting || batchBusyRef.current || !window.confirm(`“${attachment.filename}” 파일과 모든 버전을 삭제할까요? 삽입한 이미지나 링크도 더 이상 열리지 않습니다.`)) return;
    setDeleting(attachment.id);
    try {
      const expected = encodeURIComponent(attachment.currentVersionId);
      await remove(`/attachments/${encodeURIComponent(attachment.id)}?expectedVersionId=${expected}`);
      if (mountedRef.current) {
        setAttachments(previous => previous.filter(item => item.id !== attachment.id));
        versionCache.current.delete(attachment.id);
        if (versions?.attachmentId === attachment.id) {
          versionRequest.current?.abort();
          setVersions(null);
        }
        notify('첨부파일을 삭제했습니다.', 'success');
        void refreshRelated();
      }
    } catch (error) {
      if (mountedRef.current) {
        notify(message(error, '첨부파일을 삭제하지 못했습니다.'), 'error');
        if (error instanceof ApiError && [404, 409].includes(error.status)) await refreshAttachments();
      }
    } finally { if (mountedRef.current) setDeleting(null); }
  }

  async function loadVersions(attachmentId: string) {
    versionRequest.current?.abort();
    const controller = new AbortController();
    versionRequest.current = controller;
    setVersions(previous => ({
      attachmentId, versions: previous?.attachmentId === attachmentId ? previous.versions : [],
      error: '', loading: true, offset: 0,
    }));
    try {
      const result = await api<AttachmentVersion[]>(`/attachments/${encodeURIComponent(attachmentId)}/versions`, { signal: controller.signal });
      if (!controller.signal.aborted) {
        versionCache.current.set(attachmentId, result);
        setVersions({ attachmentId, versions: result, loading: false, error: '', offset: 0 });
      }
    } catch (error) {
      if (!controller.signal.aborted) setVersions(previous => previous && {
        ...previous, loading: false, error: message(error, '보존 버전을 불러오지 못했습니다.'),
      });
    }
  }

  async function refreshAttachments() {
    const result = await load();
    if (!mountedRef.current || !versions || !result) return;
    if (result.some(row => row.id === versions.attachmentId)) await loadVersions(versions.attachmentId);
    else setVersions(null);
  }

  function toggleVersions(attachment: AttachmentHead) {
    versionRequest.current?.abort();
    if (versions?.attachmentId === attachment.id) {
      setVersions(null);
      return;
    }
    const cached = versionCache.current.get(attachment.id);
    if (cached?.length === attachment.versionCount && cached.some(version => version.id === attachment.currentVersionId)) {
      setVersions({ attachmentId: attachment.id, versions: cached, loading: false, error: '', offset: 0 });
      return;
    }
    void loadVersions(attachment.id);
  }

  function selectVersionFile(attachment: AttachmentHead) {
    if (batchBusyRef.current || deleting || !versionInputRef.current) return;
    pickedAttachment.current = attachment;
    versionInputRef.current.click();
  }

  const activeUploads = uploads.filter(item => item.status !== 'done');
  const savedUpload = uploads.find(item => item.status === 'done');
  const busy = uploading || deleting !== null;

  return <section className="attachments-feature" aria-label="첨부파일">
    <div className="attachments-heading"><h3><Paperclip size={14} /> 첨부파일 <span>{attachments.length}</span></h3><button className="attachments-refresh" type="button" title="첨부파일 새로고침" aria-label="첨부파일 새로고침" disabled={loading || busy} onClick={() => void refreshAttachments()}><RefreshCw size={12} className={loading ? 'attachments-spin' : ''} /></button></div>
    <div className={`attachments-dropzone ${dragging ? 'is-dragging' : ''} ${uploading ? 'is-busy' : ''}`}
      onDragEnter={event => { if (!event.dataTransfer.types.includes('Files')) return; event.preventDefault(); dragDepthRef.current++; setDragging(true); }}
      onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = busy ? 'none' : 'copy'; } }}
      onDragLeave={event => { event.preventDefault(); dragDepthRef.current = Math.max(0, dragDepthRef.current - 1); if (!dragDepthRef.current) setDragging(false); }}
      onDrop={event => { event.preventDefault(); dragDepthRef.current = 0; setDragging(false); if (!busy) void addFiles(event.dataTransfer.files); }}>
      <input ref={inputRef} type="file" multiple className="attachments-input" aria-label="첨부할 파일 선택" disabled={busy} onChange={event => { if (event.target.files) void addFiles(event.target.files); }} />
      <UploadCloud size={20} /><p>{uploading ? '파일을 업로드하고 있어요' : '파일을 끌어놓거나 선택하세요'}</p><span>파일당 최대 20 MB</span><button className="btn btn-ghost" type="button" disabled={busy} onClick={() => inputRef.current?.click()}><Plus size={12} /> 파일 선택</button>
    </div>
    <input ref={versionInputRef} type="file" className="attachments-input" aria-label="새 버전 파일 선택" tabIndex={-1}
      disabled={busy} onChange={event => {
        const file = event.currentTarget.files?.[0], attachment = pickedAttachment.current;
        pickedAttachment.current = null;
        event.currentTarget.value = '';
        if (file && attachment) void addFiles([file], attachment);
      }} />

    {activeUploads.length > 0 && <div className="attachments-upload-list" aria-live="polite">{activeUploads.map(item => <div className={`attachments-upload ${item.status === 'error' ? 'has-error' : ''}`} key={item.id}><div><span>{item.filename}</span>{item.status === 'uploading' ? <span>{item.percent < 100 ? `${item.percent}%` : '저장 중…'}</span> : item.status === 'queued' ? <span>대기 중</span> : <button type="button" title="오류 닫기" aria-label={`${item.filename} 업로드 오류 닫기`} onClick={() => setUploads(previous => previous.filter(upload => upload.id !== item.id))}><X size={12} /></button>}</div>{item.status === 'uploading' && <div className="attachments-progress" role="progressbar" aria-label={`${item.filename} 업로드 진행률`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.percent}><span style={{ width: `${item.percent}%` }} /></div>}{item.error && <p role="alert">{item.error}</p>}</div>)}</div>}
    {loadError && <div className="attachments-error" role="alert"><p>{loadError}</p><button type="button" disabled={busy} onClick={() => void refreshAttachments()}>다시 불러오기</button></div>}
    {loading && !attachments.length && <p className="attachments-empty"><Loader2 size={12} className="attachments-spin" /> 첨부파일을 불러오는 중…</p>}
    {!loading && !loadError && !attachments.length && <p className="attachments-empty">아직 첨부된 파일이 없어요.</p>}
    <div className="attachments-list">{attachments.map(attachment => {
      const image = INLINE_MIME_TYPES.has(attachment.mimeType);
      const history = versions?.attachmentId === attachment.id ? versions : null;
      const currentVersionId = attachment.currentVersionId;
      const downloadUrl = fileUrl(currentVersionId);
      return <Fragment key={attachment.id}><article className="attachment-row">
        <div className={`attachment-symbol ${image ? 'is-image' : ''}`}>{image ? <ImageIcon size={17} /> : <File size={17} />}</div>
        <div className="attachment-description">
          <a href={downloadUrl} download={attachment.filename} title={attachment.filename}>{attachment.filename}</a>
          <span>{fileSize(attachment.size)} · {new Date(attachment.createdAt).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })}</span>
          <div className="attachment-actions">
            {attachment.hasVersionHistory && <button className="attachment-insert" type="button" aria-label={`${attachment.filename} 버전`} aria-expanded={!!history}
              disabled={busy || loading} onClick={() => toggleVersions(attachment)}><History size={12} />버전 {attachment.versionCount}</button>}
            <button className="attachment-insert" type="button" aria-label={`${attachment.filename} 새 버전 업로드`}
              disabled={busy || loading} onClick={() => selectVersionFile(attachment)}><Plus size={12} />새 버전</button>
            {image && onInsertImage && <button type="button" className="attachment-insert" onClick={() => onInsertImage(fileUrl(currentVersionId, true))}><Plus size={10} />본문에 삽입</button>}
          </div>
        </div>
        <a className="attachment-action" href={downloadUrl} download={attachment.filename} aria-label={`${attachment.filename} 다운로드`} title="다운로드"><Download size={13} /></a>
        <button className="attachment-action attachment-delete" type="button" aria-label={`${attachment.filename} 삭제`} title="모든 버전 삭제"
          disabled={busy || loading} onClick={() => void deleteFile(attachment)}>{deleting === attachment.id ? <Loader2 size={13} className="attachments-spin" /> : <Trash2 size={13} />}</button>
      </article>
      {history && <section className="attachment-history" aria-label={`${attachment.filename} 보존 버전`}>
        <div className="attachment-history-heading">
          <strong>보존한 파일 버전</strong>
          <button className="btn btn-ghost" type="button" disabled={history.loading || busy} onClick={() => void refreshAttachments()}>다시 확인</button>
        </div>
        {history.loading && <p role="status">버전 목록을 불러오는 중…</p>}
        {history.error && <p className="attachment-history-error" role="alert">{history.error}</p>}
        {!!history.versions.length && <ul>
          {history.versions.slice(history.offset, history.offset + VERSIONS_PER_PAGE).map(version => <li key={version.id}>
            <div>
              <strong>{version.versionLabel}</strong>
              <span className="attachment-history-filename" title={version.filename}>{version.filename}</span>
              <small>{version.id === currentVersionId ? '최신 버전' : '이전 버전'}
                {version.sourceImportId ? ' · 이관한 원본 버전' : ''} · {fileSize(version.size)} · {new Date(version.createdAt).toLocaleString('ko-KR')}</small>
            </div>
            <a className="btn btn-ghost" href={`/api/attachment-versions/${encodeURIComponent(version.id)}/download`} download={version.filename}
              aria-label={`${attachment.filename} 버전 ${version.versionLabel} 다운로드`}><Download size={13} />다운로드</a>
          </li>)}
        </ul>}
        {history.versions.length > VERSIONS_PER_PAGE && <div className="attachment-history-pagination">
          <span>{history.offset + 1}–{Math.min(history.offset + VERSIONS_PER_PAGE, history.versions.length)} / {history.versions.length}</span>
          <button className="btn btn-ghost" type="button" disabled={!history.offset} onClick={() => setVersions({ ...history, offset: history.offset - VERSIONS_PER_PAGE })}>이전 버전 페이지</button>
          <button className="btn btn-ghost" type="button" disabled={history.offset + VERSIONS_PER_PAGE >= history.versions.length}
            onClick={() => setVersions({ ...history, offset: history.offset + VERSIONS_PER_PAGE })}>다음 버전 페이지</button>
        </div>}
      </section>}</Fragment>;
    })}</div>
    {!uploading && savedUpload && <p className="attachments-success" role="status">
      <Check size={11} />{savedUpload.isVersion ? '새 버전을 저장했습니다.' : '파일을 첨부했습니다.'}
    </p>}
  </section>;
}
