'use client';

import { useEffect, useRef, useState } from 'react';
import { Download, FileClock, RefreshCw, X } from 'lucide-react';
import type { LegacyRecordKind, SourceRecordArchive, SourceRecordPage, SourceRecordSummary } from '../../shared/types';
import { api } from '../lib/api';
import './source-origins.css';

const kindLabels: Record<LegacyRecordKind, string> = { identity: '원본 사용자', project: '프로젝트·공간', issue: '업무', page: '문서', comment: '댓글', revision: '문서 버전', history: '변경 이력', attachment: '첨부', relation: '관계', field: '속성', option: '선택 항목', workflow: '워크플로' };
const message = (error: unknown) => error instanceof Error ? error.message : '원본 기록을 불러오지 못했습니다.';
export interface SourceOriginsProps { resourceType: 'issue' | 'document'; resourceId: string }
export function SourceOrigins(props: SourceOriginsProps) { return <Records key={`${props.resourceType}:${props.resourceId}`} resource={props} />; }
export function SourceImportRecords({ sourceImportId }: { sourceImportId: string }) { return <Records key={sourceImportId} sourceImportId={sourceImportId} />; }

function Records({ sourceImportId, resource }: { sourceImportId?: string; resource?: SourceOriginsProps }) {
  const [kind, setKind] = useState(''), [offset, setOffset] = useState(0), [query, setQuery] = useState(''), [generation, setGeneration] = useState(0);
  const [result, setResult] = useState<SourceRecordPage | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<SourceRecordSummary | null>(null), [detail, setDetail] = useState<SourceRecordArchive | null>(null), [detailError, setDetailError] = useState(''), [detailLoading, setDetailLoading] = useState(false);
  const detailAbort = useRef<AbortController | null>(null);
  const resourceType = resource?.resourceType, resourceId = resource?.resourceId;
  useEffect(() => {
    const abort = new AbortController(), params = new URLSearchParams({ offset: String(offset), limit: '50' }); if (kind) params.set('kind', kind);
    if (resourceType && resourceId) { params.set('resourceType', resourceType); params.set('resourceId', resourceId); }
    const path = sourceImportId ? `/source-imports/${encodeURIComponent(sourceImportId)}/records?${params}` : `/resource-origins?${params}`;
    const timer = setTimeout(() => { setLoading(true); void api<SourceRecordPage>(path, { signal: abort.signal }).then(value => { if (!abort.signal.aborted) { setResult(value); setError(''); } }).catch(cause => { if (!abort.signal.aborted) setError(message(cause)); }).finally(() => { if (!abort.signal.aborted) setLoading(false); }); }, 0);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [sourceImportId, resourceType, resourceId, kind, offset, generation]);
  useEffect(() => () => detailAbort.current?.abort(), []);
  function clearDetail() { detailAbort.current?.abort(); setSelected(null); setDetail(null); setDetailError(''); setDetailLoading(false); }
  async function openRecord(row: SourceRecordSummary) {
    detailAbort.current?.abort(); const abort = new AbortController(); detailAbort.current = abort; setSelected(row); setDetail(null); setDetailError(''); setDetailLoading(true);
    try { const value = await api<SourceRecordArchive>(`/source-imports/${encodeURIComponent(row.sourceImportId)}/records/${encodeURIComponent(row.id)}`, { signal: abort.signal }); if (!abort.signal.aborted) setDetail(value); }
    catch (cause) { if (!abort.signal.aborted) setDetailError(message(cause)); } finally { if (!abort.signal.aborted) setDetailLoading(false); }
  }
  const visible = result?.records.filter(row => `${row.record.title} ${row.record.sourceId} ${row.originalAuthorName || ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) || [];
  return <section className="source-origins" aria-label={resource ? '원본 이관 기록' : '이관 영수증 원본 기록'}>
    <header><div><h3><FileClock size={18} />원본 기록</h3><p>원래 키·작성자·시각과 변경 이력·댓글·문서 버전·첨부를 읽기 전용으로 확인합니다.</p></div><button className="btn btn-ghost" aria-label="원본 이관 기록 새로고침" disabled={loading} onClick={() => setGeneration(value => value + 1)}><RefreshCw size={15} />새로고침</button></header>
    <div className="source-origins-filters"><label>원본 기록 종류<select className="field" aria-label="원본 이관 기록 종류" value={kind} onChange={event => { setKind(event.target.value); setOffset(0); setResult(null); clearDetail(); }}><option value="">전체 기록</option>{Object.entries(kindLabels).map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label><label>현재 페이지에서 찾기<input className="field" aria-label="현재 원본 기록 페이지 검색" value={query} onChange={event => setQuery(event.target.value)} maxLength={300} placeholder="제목·원본 ID·작성자" /></label></div>
    {error && <p className="source-origin-error" role="alert">{error} 기존 기록은 유지됩니다.</p>}{loading && <p role="status">원본 기록을 불러오는 중…</p>}
    {result && <><div className="source-origin-list" aria-label="보존한 원본 기록 목록">{visible.map(row => <button className={`source-origin-row ${selected?.id === row.id ? 'is-selected' : ''}`} key={row.id} onClick={() => void openRecord(row)}><span>{kindLabels[row.record.kind]}</span><div><strong>{row.record.title || '(제목 없음)'}</strong><small>원본 {row.record.sourceId} · {row.source.product} / {row.source.instanceKey}</small><small>작성자 {row.originalAuthorName || row.record.authorId || '원본에 없음'} · 생성 {row.record.createdAt || '원본에 없음'} · 수정 {row.record.updatedAt || '원본에 없음'}</small></div></button>)}{!visible.length && <p>{result.total ? '현재 페이지에서 조건에 맞는 기록이 없습니다.' : '연결된 원본 이관 기록이 없습니다.'}</p>}</div><div className="source-origin-pagination"><span>{result.total ? offset + 1 : 0}–{Math.min(offset + 50, result.total)} / {result.total.toLocaleString()}개</span><button className="btn btn-ghost" aria-label="원본 이관 기록 이전 페이지" disabled={loading || offset === 0} onClick={() => { setOffset(Math.max(0, offset - 50)); clearDetail(); }}>이전</button><button className="btn btn-ghost" aria-label="원본 이관 기록 다음 페이지" disabled={loading || offset + 50 >= result.total} onClick={() => { setOffset(offset + 50); clearDetail(); }}>다음</button></div></>}
    {detailLoading && <p role="status">원본 기록 상세를 불러오는 중…</p>}{detailError && <p className="source-origin-error" role="alert">{detailError}</p>}{detail && <ArchiveDetail archive={detail} originalAuthorName={selected?.originalAuthorName || null} onClose={clearDetail} />}
  </section>;
}
function ArchiveDetail({ archive, originalAuthorName, onClose }: { archive: SourceRecordArchive; originalAuthorName: string | null; onClose: () => void }) {
  const record = archive.record, limit = 20000, metadata = JSON.stringify(record.metadata, null, 2), references = JSON.stringify(record.references, null, 2);
  const originalKey = typeof record.metadata.key === 'string' ? record.metadata.key : typeof record.metadata.pkey === 'string' ? record.metadata.pkey : null;
  const bodyPreview = record.text.slice(0, limit), metadataPreview = metadata.slice(0, Math.max(0, limit - bodyPreview.length)), referencePreview = references.slice(0, Math.max(0, limit - bodyPreview.length - metadataPreview.length));
  const truncated = record.text.length + metadata.length + references.length > limit;
  function download() { const url = URL.createObjectURL(new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json;charset=utf-8' })), anchor = document.createElement('a'); anchor.href = url; anchor.download = `source-${record.kind}-${record.sourceId.replace(/[^a-zA-Z0-9가-힣_-]/g, '_').slice(0, 80)}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  return <section className="source-origin-detail" aria-label="보존한 원본 기록 상세"><header><h4>{record.title || '(제목 없음)'}</h4><button className="btn btn-ghost" aria-label="원본 이관 기록 상세 닫기" onClick={onClose}><X size={16} />닫기</button></header><dl><dt>원본 종류</dt><dd>{kindLabels[record.kind]}</dd><dt>원래 키 / ID</dt><dd>{originalKey ? `${originalKey} / ` : ''}{record.sourceId}</dd><dt>원본 작성자</dt><dd>{originalAuthorName || record.authorId || '원본에 없음'}{originalAuthorName && record.authorId && ` · ${record.authorId}`}</dd><dt>원본 생성 시각</dt><dd>{record.createdAt || '원본에 없음'}</dd><dt>원본 수정 시각</dt><dd>{record.updatedAt || '원본에 없음'}</dd><dt>원본 서버 / 시간대</dt><dd>{archive.source.instanceKey} · {archive.source.timezone || '지정되지 않음'}</dd><dt>본문 형식</dt><dd>{record.textFormat}</dd><dt>원본 패키지 SHA-256</dt><dd><code>{archive.packageSha256}</code></dd></dl><div className="source-origin-raw-actions"><p>{truncated ? '부분 표시: 본문·메타데이터·관계 합계 20,000자까지 표시합니다. 전체 원문은 JSON으로 내려받을 수 있습니다.' : '원본 마크업은 실행하지 않고 문자열로 표시합니다.'}</p><button className="btn" onClick={download}><Download size={16} />원본 기록 전체 JSON 다운로드</button></div><h5>원본 본문</h5><pre aria-label="보존한 원본 본문">{bodyPreview || '(본문 없음)'}</pre><details><summary>원본 메타데이터</summary>{metadataPreview ? <pre>{metadataPreview}</pre> : <p>표시 한도에 도달했습니다. 전체 JSON을 확인하세요.</p>}</details><details><summary>원본 관계</summary>{referencePreview ? <pre>{referencePreview}</pre> : <p>표시 한도에 도달했습니다. 전체 JSON을 확인하세요.</p>}</details></section>;
}
