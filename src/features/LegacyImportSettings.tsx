'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Archive, ChevronLeft, ChevronRight, FileSearch, Loader2, RefreshCw, Search, Trash2, Upload, X } from 'lucide-react';
import type { FeatureProps, LegacyDiagnosticPage, LegacyPackageDetail, LegacyPackageSummary, LegacyRecord, LegacyRecordKind, LegacyRecordPage } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { afterAcceptedNavigation } from '../lib/navigation';
import './legacy-import.css';

const MAX_FILE_BYTES = 64 * 1024 * 1024, PAGE_SIZE = 50;
type Product = 'auto' | 'jira' | 'confluence';
type Tab = 'records' | 'diagnostics' | 'files';
const KINDS: Record<LegacyRecordKind, string> = { identity: '사용자', project: '프로젝트·공간', issue: '업무', page: '문서', comment: '댓글', revision: '문서 버전', history: '변경 이력', attachment: '첨부파일', relation: '관계', field: '필드', option: '선택지', workflow: '워크플로' };
const message = (cause: unknown) => cause instanceof Error ? cause.message : '원본 분석 요청을 처리하지 못했습니다.';
const sizeLabel = (bytes: number) => bytes < 1024 ? `${bytes.toLocaleString()} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
const dateLabel = (value: string | null) => value ? new Date(value).toLocaleString('ko-KR') : '원본에 없음';

export function LegacyImportSettings(props: FeatureProps) { return <ActorLegacyImportSettings key={props.actorId} {...props} />; }
function ActorLegacyImportSettings({ actorId, notify }: FeatureProps) {
  const [packages, setPackages] = useState<LegacyPackageSummary[]>([]), [loading, setLoading] = useState(true), [listError, setListError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null), [detail, setDetail] = useState<LegacyPackageDetail | null>(null), [detailLoading, setDetailLoading] = useState(false), [detailError, setDetailError] = useState('');
  const [file, setFile] = useState<File | null>(null), [instanceKey, setInstanceKey] = useState(''), [product, setProduct] = useState<Product>('auto');
  const [baseline, setBaseline] = useState<{ instanceKey: string; product: Product }>({ instanceKey: '', product: 'auto' });
  const [pending, setPending] = useState(false), [actionError, setActionError] = useState(''), [refreshKey, setRefreshKey] = useState(0);
  const [tab, setTab] = useState<Tab>('records'), [kind, setKind] = useState(''), [query, setQuery] = useState(''), [appliedQuery, setAppliedQuery] = useState(''), [recordOffset, setRecordOffset] = useState(0);
  const [recordPage, setRecordPage] = useState<LegacyRecordPage | null>(null), [recordLoading, setRecordLoading] = useState(false), [recordError, setRecordError] = useState(''), [selectedRecord, setSelectedRecord] = useState<LegacyRecord | null>(null);
  const [recordDetailLoading, setRecordDetailLoading] = useState(false), [recordDetailError, setRecordDetailError] = useState('');
  const [severity, setSeverity] = useState(''), [diagnosticOffset, setDiagnosticOffset] = useState(0), [diagnosticPage, setDiagnosticPage] = useState<LegacyDiagnosticPage | null>(null), [diagnosticLoading, setDiagnosticLoading] = useState(false), [diagnosticError, setDiagnosticError] = useState('');
  const [fileOffset, setFileOffset] = useState(0);
  const active = useRef(true), busy = useRef(false), dirty = useRef(false), fileInput = useRef<HTMLInputElement>(null), listSequence = useRef(0), detailSequence = useRef(0), recordSequence = useRef(0), diagnosticSequence = useRef(0), recordDetailSequence = useRef(0);
  const isDirty = Boolean(file || instanceKey !== baseline.instanceKey || product !== baseline.product);
  useEffect(() => { dirty.current = isDirty; }, [isDirty]);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const loadPackages = useCallback(async () => {
    const sequence = ++listSequence.current; setLoading(true);
    try { const values = await api<LegacyPackageSummary[]>('/legacy-import/packages'); if (active.current && sequence === listSequence.current) { setPackages(values); setListError(''); } }
    catch (cause) { if (active.current && sequence === listSequence.current) setListError(message(cause)); }
    finally { if (active.current && sequence === listSequence.current) setLoading(false); }
  }, []);
  useEffect(() => { const timer = setTimeout(() => { void loadPackages(); }, 0); return () => clearTimeout(timer); }, [loadPackages, refreshKey]);
  useEffect(() => {
    const sequence = ++detailSequence.current;
    if (!selectedId) return;
    const timer = setTimeout(() => {
      setDetailLoading(true);
      void api<LegacyPackageDetail>(`/legacy-import/packages/${encodeURIComponent(selectedId)}`).then(value => {
        if (active.current && sequence === detailSequence.current) { setDetail(value); setDetailError(''); }
      }).catch(cause => { if (active.current && sequence === detailSequence.current) setDetailError(message(cause)); }).finally(() => { if (active.current && sequence === detailSequence.current) setDetailLoading(false); });
    }, 0); return () => clearTimeout(timer);
  }, [selectedId, refreshKey]);
  useEffect(() => {
    const sequence = ++recordSequence.current;
    if (!selectedId || tab !== 'records') return;
    const params = new URLSearchParams({ offset: String(recordOffset), limit: String(PAGE_SIZE), ...(kind ? { kind } : {}), ...(appliedQuery ? { q: appliedQuery } : {}) });
    const timer = setTimeout(() => {
      setRecordLoading(true);
      void api<LegacyRecordPage>(`/legacy-import/packages/${encodeURIComponent(selectedId)}/records?${params}`).then(value => { if (active.current && sequence === recordSequence.current) { setRecordPage(value); setRecordError(''); } }).catch(cause => { if (active.current && sequence === recordSequence.current) setRecordError(message(cause)); }).finally(() => { if (active.current && sequence === recordSequence.current) setRecordLoading(false); });
    }, 0); return () => clearTimeout(timer);
  }, [selectedId, tab, kind, appliedQuery, recordOffset, refreshKey]);
  useEffect(() => {
    const sequence = ++diagnosticSequence.current;
    if (!selectedId || tab !== 'diagnostics') return;
    const params = new URLSearchParams({ offset: String(diagnosticOffset), limit: String(PAGE_SIZE), ...(severity ? { severity } : {}) });
    const timer = setTimeout(() => {
      setDiagnosticLoading(true);
      void api<LegacyDiagnosticPage>(`/legacy-import/packages/${encodeURIComponent(selectedId)}/diagnostics?${params}`).then(value => { if (active.current && sequence === diagnosticSequence.current) { setDiagnosticPage(value); setDiagnosticError(''); } }).catch(cause => { if (active.current && sequence === diagnosticSequence.current) setDiagnosticError(message(cause)); }).finally(() => { if (active.current && sequence === diagnosticSequence.current) setDiagnosticLoading(false); });
    }, 0); return () => clearTimeout(timer);
  }, [selectedId, tab, severity, diagnosticOffset, refreshKey]);
  const resetDraft = useCallback(() => { setFile(null); if (fileInput.current) fileInput.current.value = ''; setInstanceKey(baseline.instanceKey); setProduct(baseline.product); setActionError(''); dirty.current = false; }, [baseline]);
  useEffect(() => {
    const navigate = (event: Event) => {
      if (event.defaultPrevented) return;
      if (busy.current) { event.preventDefault(); notify('원본 분석·삭제가 끝난 뒤 이동해 주세요.', 'error'); return; }
      if (dirty.current) {
        if (!window.confirm('선택한 원본 파일과 입력 중인 분석 설정을 버리고 이동할까요?')) event.preventDefault();
        else afterAcceptedNavigation(event, resetDraft);
      }
    };
    const unload = (event: BeforeUnloadEvent) => { if (busy.current || dirty.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('teamspace:navigate', navigate); window.addEventListener('beforeunload', unload);
    return () => { window.removeEventListener('teamspace:navigate', navigate); window.removeEventListener('beforeunload', unload); };
  }, [notify, resetDraft]);
  function clearRecord() { recordDetailSequence.current++; setSelectedRecord(null); setRecordDetailError(''); setRecordDetailLoading(false); }
  function choosePackage(id: string) { if (id === selectedId) return; setSelectedId(id); setDetail(null); setRecordPage(null); setDiagnosticPage(null); clearRecord(); setRecordOffset(0); setDiagnosticOffset(0); setFileOffset(0); setDetailError(''); setRecordError(''); setDiagnosticError(''); setKind(''); setQuery(''); setAppliedQuery(''); setSeverity(''); }
  async function openRecord(id: string) {
    if (!selectedId) return;
    const sequence = ++recordDetailSequence.current; setSelectedRecord(null); setRecordDetailLoading(true); setRecordDetailError('');
    try { const value = await api<LegacyRecord>(`/legacy-import/packages/${encodeURIComponent(selectedId)}/records/${encodeURIComponent(id)}`); if (active.current && sequence === recordDetailSequence.current) setSelectedRecord(value); }
    catch (cause) { if (active.current && sequence === recordDetailSequence.current) setRecordDetailError(message(cause)); }
    finally { if (active.current && sequence === recordDetailSequence.current) setRecordDetailLoading(false); }
  }
  async function upload(event: FormEvent) {
    event.preventDefault(); if (!file || !instanceKey.trim() || busy.current) return;
    if (file.size > MAX_FILE_BYTES) { setActionError('원본 파일은 64 MiB 이하여야 합니다. 선택한 파일과 입력은 유지됩니다.'); return; }
    if (!/\.(?:zip|xml|csv|json)$/i.test(file.name)) { setActionError('ZIP·XML·CSV·JSON 파일을 선택해 주세요.'); return; }
    busy.current = true; setPending(true); setActionError('');
    try {
      const params = new URLSearchParams({ filename: file.name, instanceKey: instanceKey.trim(), product });
      const response = await fetch(`/api/legacy-import/packages?${params}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Actor-Id': actorId }, body: file });
      if (!response.ok) { const value = await response.json().catch(() => null) as { error?: string } | null; throw new ApiError(response.status, typeof value?.error === 'string' ? value.error : '원본 분석을 완료하지 못했습니다.'); }
      const summary = await response.json() as LegacyPackageSummary;
      if (!active.current) return;
      setPackages(values => [summary, ...values.filter(value => value.id !== summary.id)]); setFile(null); if (fileInput.current) fileInput.current.value = '';
      const saved = { instanceKey: instanceKey.trim(), product }; setInstanceKey(saved.instanceKey); setBaseline(saved); dirty.current = false;
      choosePackage(summary.id); setTab('records'); setRefreshKey(value => value + 1);
      notify(response.status === 200 ? '동일한 원본 분석 패키지를 다시 열었습니다.' : '원본 분석을 저장했습니다. 현재 업무·문서는 변경되지 않았습니다.');
    } catch (cause) { if (active.current) setActionError(`${message(cause)} 선택한 파일과 입력은 유지됩니다.`); }
    finally { busy.current = false; if (active.current) setPending(false); }
  }
  async function deletePackage() {
    if (!detail || busy.current || !window.confirm('이 원본 분석 패키지를 삭제할까요? 현재 업무·문서는 변경되지 않습니다.')) return;
    busy.current = true; setPending(true); setActionError('');
    try {
      await api(`/legacy-import/packages/${encodeURIComponent(detail.summary.id)}?expectedVersion=${detail.summary.version}`, { method: 'DELETE', headers: { 'X-Actor-Id': actorId } });
      if (!active.current) return;
      setPackages(values => values.filter(value => value.id !== detail.summary.id)); setSelectedId(null); setDetail(null); clearRecord(); notify('원본 분석 패키지를 삭제했습니다.');
    } catch (cause) { if (active.current) setActionError(`${message(cause)} 기존 미리보기와 입력은 유지됩니다. 새로고침으로 최신 버전을 확인하세요.`); }
    finally { busy.current = false; if (active.current) setPending(false); }
  }
  const selectedDetail = detail?.summary.id === selectedId ? detail : null;
  return <section className="card legacy-import-settings" aria-label="기존 도구 원본 분석">
    <header className="legacy-card-heading"><div><h2><Archive size={20} />기존 도구 원본 분석</h2><p>Jira·Confluence 내보내기 파일을 읽고 이관할 원본과 누락 항목을 확인합니다.</p></div><button className="btn btn-ghost" aria-label="원본 분석 새로고침" disabled={loading || pending} onClick={() => setRefreshKey(value => value + 1)}><RefreshCw size={16} />새로고침</button></header>
    <p className="legacy-analysis-notice"><strong>원본을 분석하고 누락 항목을 확인하세요.</strong> 분석을 마치면 아래 실제 데이터 이관에서 매핑하고 새 프로젝트에 적용할 수 있습니다.</p>
    <form className="legacy-upload-form" aria-label="원본 파일 분석" onSubmit={event => void upload(event)}><fieldset disabled={pending}>
      <label>원본 파일<input ref={fileInput} className="field" type="file" accept=".zip,.xml,.csv,.json" aria-label="Jira·Confluence 원본 파일" onChange={event => { setFile(event.target.files?.[0] || null); setActionError(''); }} /></label>
      <label>원본 인스턴스 식별값<input className="field" aria-label="원본 인스턴스 식별값" value={instanceKey} onChange={event => setInstanceKey(event.target.value)} maxLength={500} placeholder="예: jira-team-original" required /></label>
      <label>원본 도구<select className="field" aria-label="원본 도구" value={product} onChange={event => setProduct(event.target.value as Product)}><option value="auto">자동 판별</option><option value="jira">Jira</option><option value="confluence">Confluence</option></select></label>
      <p className="legacy-upload-help">외부 서비스에 연결하지 않습니다. 식별값은 같은 원본 서버에서 내보낸 자료를 구분하는 매핑 공간입니다. ZIP·XML·CSV·JSON, 최대 64 MiB.</p>
      {file && <p className="legacy-file-selected">{file.name} · {sizeLabel(file.size)}{file.size > MAX_FILE_BYTES && <strong> · 64 MiB 한도 초과</strong>}</p>}
      <div className="legacy-upload-actions"><button className="btn btn-ghost" type="button" disabled={!isDirty} onClick={() => { if (window.confirm('선택한 파일과 분석 설정 입력을 초기화할까요?')) resetDraft(); }}><X size={15} />입력 초기화</button><button className="btn btn-primary" type="submit" disabled={!file || file.size > MAX_FILE_BYTES || !instanceKey.trim()}>{pending ? <Loader2 size={16} className="spin" /> : <Upload size={16} />}{pending ? '처리 중…' : '원본 분석 시작'}</button></div>
    </fieldset></form>
    {pending && <p className="legacy-pending" role="status">원본 파일을 분석하거나 패키지를 정리하는 중입니다. 처리 결과가 나올 때까지 기다려 주세요.</p>}
    {actionError && <p className="legacy-error" role="alert">{actionError}</p>}{listError && <p className="legacy-error" role="alert">{listError} 기존 목록은 유지됩니다.</p>}
    <div className="legacy-package-layout"><aside className="legacy-package-list" aria-label="원본 분석 패키지 목록"><h3>보관한 분석</h3>{loading && !packages.length ? <p className="muted">목록을 불러오는 중…</p> : !packages.length ? <p className="muted">아직 분석한 원본 파일이 없습니다.</p> : packages.map(value => <button type="button" key={value.id} className={`legacy-package-item ${selectedId === value.id ? 'is-selected' : ''}`} disabled={pending} onClick={() => choosePackage(value.id)}><strong>{value.filename}</strong><span>{value.source.product === 'jira' ? 'Jira' : 'Confluence'} · {value.source.instanceKey}</span><small>객체 {Object.values(value.counts).reduce((sum, count) => sum + (count || 0), 0).toLocaleString()} · 오류 {value.errors} · 경고 {value.warnings}</small><small>{dateLabel(value.createdAt)}</small></button>)}</aside>
      <div className="legacy-package-preview">{detailLoading && <p className="muted">분석 상세를 불러오는 중…</p>}{detailError && <p className="legacy-error" role="alert">{detailError}</p>}{!selectedId && <div className="legacy-preview-empty"><FileSearch size={30} /><p>패키지를 선택하면 원본 객체·진단·파일 목록을 볼 수 있습니다.</p></div>}
        {selectedDetail && <><header className="legacy-summary-heading"><div><h3>{selectedDetail.summary.filename}</h3><p>{selectedDetail.summary.source.format} · {selectedDetail.summary.source.instanceKey}</p></div><button className="btn btn-ghost" aria-label="선택한 원본 분석 삭제" disabled={pending || detailLoading} onClick={() => void deletePackage()}><Trash2 size={15} />분석 삭제</button></header>
          <div className="legacy-summary-counts" aria-label="원본 분석 요약">{Object.entries(selectedDetail.summary.counts).map(([key, count]) => <span key={key}>{KINDS[key as LegacyRecordKind] || key} <strong>{count}</strong></span>)}<span>오류 <strong>{selectedDetail.summary.errors}</strong></span><span>경고 <strong>{selectedDetail.summary.warnings}</strong></span><span>파일 <strong>{selectedDetail.summary.fileCount}</strong></span></div>
          <dl className="legacy-summary-metadata"><dt>원본 도구 버전</dt><dd>{selectedDetail.summary.source.declaredVersion || '원본에 없음'}</dd><dt>원본 시간대</dt><dd>{selectedDetail.summary.source.timezone || '원본에 없음'}</dd><dt>파일 크기 / 해제 크기</dt><dd>{sizeLabel(selectedDetail.summary.size)} / {sizeLabel(selectedDetail.summary.expandedBytes)}</dd><dt>SHA-256</dt><dd><code>{selectedDetail.summary.sha256}</code></dd></dl>
          {selectedDetail.unsupported.length > 0 && <div className="legacy-unsupported"><strong>지원하지 않는 원본 객체</strong><ul>{selectedDetail.unsupported.map(value => <li key={value.type}>{value.type} · {value.count}개</li>)}</ul></div>}
          <div className="legacy-tabs" role="tablist" aria-label="원본 패키지 자료">{([['records', '원본 객체'], ['diagnostics', '분석 진단'], ['files', '파일 목록']] as const).map(([value, label]) => <button role="tab" type="button" id={`legacy-tab-${value}`} aria-controls={`legacy-panel-${value}`} aria-selected={tab === value} key={value} onClick={() => setTab(value)}>{label}</button>)}</div>
          {tab === 'records' && <section role="tabpanel" id="legacy-panel-records" aria-labelledby="legacy-tab-records"><form className="legacy-filters" onSubmit={(event: FormEvent) => { event.preventDefault(); setAppliedQuery(query.trim()); setRecordOffset(0); clearRecord(); }}><label>객체 종류<select className="field" aria-label="원본 객체 종류" value={kind} onChange={event => { setKind(event.target.value); setRecordOffset(0); clearRecord(); }}><option value="">전체 종류</option>{Object.entries(KINDS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>원본 객체 검색<input className="field" aria-label="원본 객체 검색" value={query} maxLength={500} onChange={event => setQuery(event.target.value)} placeholder="제목·식별자·본문 검색" /></label><button className="btn" type="submit"><Search size={15} />검색</button></form>
            {recordError && <p className="legacy-error" role="alert">{recordError}</p>}{recordLoading && <p role="status">원본 객체를 불러오는 중…</p>}
            {recordPage && <><div className="legacy-record-list" aria-label="원본 객체 목록">{recordPage.records.length ? recordPage.records.map(value => <button className={`legacy-record-item ${selectedRecord?.id === value.id ? 'is-selected' : ''}`} type="button" key={value.id} onClick={() => void openRecord(value.id)}><span>{KINDS[value.kind]}</span><strong>{value.title || '(제목 없음)'}</strong><small>{value.sourceId}</small></button>) : <p className="muted">조건에 맞는 원본 객체가 없습니다.</p>}</div><Pagination label="원본 객체" offset={recordOffset} total={recordPage.total} loading={recordLoading} onChange={value => { setRecordOffset(value); clearRecord(); }} /></>}
            {recordDetailLoading && <p role="status">원본 객체 상세를 불러오는 중…</p>}{recordDetailError && <p className="legacy-error" role="alert">{recordDetailError}</p>}{selectedRecord && <RecordDetail record={selectedRecord} onClose={clearRecord} />}
          </section>}
          {tab === 'diagnostics' && <section role="tabpanel" id="legacy-panel-diagnostics" aria-labelledby="legacy-tab-diagnostics"><div className="legacy-filters"><label>진단 심각도<select className="field" aria-label="분석 진단 심각도" value={severity} onChange={event => { setSeverity(event.target.value); setDiagnosticOffset(0); }}><option value="">전체 진단</option><option value="error">오류</option><option value="warning">경고</option><option value="info">안내</option></select></label></div>{diagnosticError && <p className="legacy-error" role="alert">{diagnosticError}</p>}{diagnosticLoading && <p role="status">진단을 불러오는 중…</p>}{diagnosticPage && <><ul className="legacy-diagnostics">{diagnosticPage.diagnostics.map(value => <li key={value.id}><div><span className={`legacy-severity is-${value.severity}`}>{value.severity === 'error' ? '오류' : value.severity === 'warning' ? '경고' : '안내'}</span><code>{value.code}</code></div><p>{value.message}</p>{value.recordId && <small>원본 객체: {value.recordId}</small>}{value.path && <small>파일: {value.path}</small>}</li>)}</ul>{!diagnosticPage.total && <p className="muted">이 조건에 해당하는 진단이 없습니다.</p>}<Pagination label="진단" offset={diagnosticOffset} total={diagnosticPage.total} loading={diagnosticLoading} onChange={setDiagnosticOffset} /></>}</section>}
          {tab === 'files' && <section role="tabpanel" id="legacy-panel-files" aria-labelledby="legacy-tab-files"><div className="legacy-file-table"><table><thead><tr><th>파일 경로</th><th>크기</th><th>SHA-256</th></tr></thead><tbody>{selectedDetail.files.slice(fileOffset, fileOffset + PAGE_SIZE).map(value => <tr key={value.path}><td>{value.path}</td><td>{sizeLabel(value.size)}</td><td><code>{value.sha256}</code></td></tr>)}</tbody></table></div><Pagination label="파일" offset={fileOffset} total={selectedDetail.files.length} loading={false} onChange={setFileOffset} /></section>}
        </>}
      </div>
    </div>
  </section>;
}
function Pagination({ label, offset, total, loading, onChange }: { label: string; offset: number; total: number; loading: boolean; onChange: (offset: number) => void }) {
  return <div className="legacy-pagination"><span>{total ? `${offset + 1}–${Math.min(total, offset + PAGE_SIZE)} / ${total.toLocaleString()}개` : '0개'}</span><button className="btn btn-ghost" type="button" aria-label={`${label} 이전 페이지`} disabled={loading || offset === 0} onClick={() => onChange(Math.max(0, offset - PAGE_SIZE))}><ChevronLeft size={16} />이전</button><button className="btn btn-ghost" type="button" aria-label={`${label} 다음 페이지`} disabled={loading || offset + PAGE_SIZE >= total} onClick={() => onChange(offset + PAGE_SIZE)}><ChevronRight size={16} />다음</button></div>;
}
function RecordDetail({ record, onClose }: { record: LegacyRecord; onClose: () => void }) {
  const limit = 20000, metadata = JSON.stringify(record.metadata, null, 2), references = JSON.stringify(record.references, null, 2);
  const bodyPreview = record.text.slice(0, limit), metadataPreview = metadata.slice(0, Math.max(0, limit - bodyPreview.length));
  const referencePreview = references.slice(0, Math.max(0, limit - bodyPreview.length - metadataPreview.length));
  const truncated = record.text.length + metadata.length + references.length > limit;
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], { type: 'application/json;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `legacy-${record.kind}-${record.sourceId.replace(/[^a-zA-Z0-9가-힣_-]/g, '_').slice(0, 80)}.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className="legacy-record-detail" aria-label="원본 객체 상세"><header><h4>{record.title || '(제목 없음)'}</h4><button className="btn btn-ghost" type="button" aria-label="원본 객체 상세 닫기" onClick={onClose}><X size={16} />닫기</button></header>
    <dl><dt>원본 ID / 종류</dt><dd>{record.sourceId} · {KINDS[record.kind]}</dd><dt>컨테이너 / 상위 ID</dt><dd>{record.containerId || '없음'} / {record.parentId || '없음'}</dd><dt>작성자 ID</dt><dd>{record.authorId || '원본에 없음'}</dd><dt>생성 시각</dt><dd>{record.createdAt || '원본에 없음'}</dd><dt>수정 시각</dt><dd>{record.updatedAt || '원본에 없음'}</dd><dt>본문 형식</dt><dd>{record.textFormat}</dd></dl>
    <div className="legacy-raw-actions"><p>{truncated ? '부분 표시: 본문·메타데이터·관계는 화면에 합계 20,000자까지만 표시합니다. 전체 JSON에는 원문 전체가 보존됩니다.' : '원본 문자열을 읽기 전용으로 표시합니다. 마크업은 실행하지 않습니다.'}</p><button className="btn" type="button" onClick={download}>원본 객체 전체 JSON 다운로드</button></div>
    <h5>원본 본문</h5><pre className="legacy-raw-body" aria-label="원본 본문">{bodyPreview || '(본문 없음)'}</pre>
    <details><summary>원본 메타데이터</summary>{metadataPreview ? <pre>{metadataPreview}</pre> : <p>화면 표시 한도에 도달했습니다. 전체 JSON에서 확인해 주세요.</p>}</details>
    <details><summary>원본 관계 {record.references.length}개</summary>{referencePreview ? <pre>{referencePreview}</pre> : <p>화면 표시 한도에 도달했습니다. 전체 JSON에서 확인해 주세요.</p>}</details>
  </section>;
}
