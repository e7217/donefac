'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { FileSearch, Search, X } from 'lucide-react';
import type {
  LegacyPackageSummary, LegacyRecord, MigrationContentReviewDetail, MigrationContentReviewPage,
  MigrationContentReviewRow, MigrationPreview, WorkspaceSnapshot,
} from '../../shared/types';
import { api } from '../lib/api';
import { DocumentBlocksProvider, ReadonlyDocumentContent } from './DocumentBlocks';
import { ReadonlyIssueDescription } from './IssueDescriptionEditor';
import { LegacyRecordDetail } from './LegacyRecordDetail';

const PAGE_SIZE = 12;
const keepReading = () => {};
type Inspection = { row: MigrationContentReviewRow; opener: HTMLButtonElement };
type Result<T> = { value: T } | { error: string };

function read<T>(path: string, actorId: string, receive: (value: Result<T>) => void) {
  const request = new AbortController();
  void api<T>(path, { cache: 'no-store', signal: request.signal, headers: { 'X-Actor-Id': actorId } })
    .then(value => { if (!request.signal.aborted) receive({ value }); })
    .catch(cause => {
      if (!request.signal.aborted) receive({ error: cause instanceof Error ? cause.message : '변환 결과를 읽지 못했습니다.' });
    });
  return () => request.abort();
}

export function MigrationContentReview({ preview, packages, data, actorId, busy }: {
  preview: MigrationPreview; packages: LegacyPackageSummary[]; data: WorkspaceSnapshot; actorId: string; busy: boolean;
}) {
  const [packageId, setPackageId] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; page: Result<MigrationContentReviewPage> } | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const path = `/migrations/previews/${encodeURIComponent(preview.id)}/content`;
  const version = String(preview.version);
  const params = new URLSearchParams({ expectedVersion: version, offset: String(offset), limit: String(PAGE_SIZE) });
  if (packageId) params.set('packageId', packageId);
  if (query) params.set('q', query);
  const request = `${path}?${params}`;
  const requestKey = `${attempt}:${request}`;
  const page = result?.key === requestKey ? result.page : null;
  const visiblePage = page && 'value' in page ? page.value : null;
  const lastTotal = !page && result && 'value' in result.page ? result.page.value.total : 0;
  const canGoBack = Boolean(!busy && visiblePage && offset > 0);
  const canGoForward = Boolean(!busy && visiblePage && offset + PAGE_SIZE < visiblePage.total);
  const sources = packages.filter(source => preview.configuration.packageIds.includes(source.id));
  const filenames = new Map(sources.map(source => [source.id, source.filename]));

  useEffect(() => {
    if (busy) return;
    return read<MigrationContentReviewPage>(request, actorId, response => setResult({ key: requestKey, page: response }));
  }, [actorId, busy, request, requestKey]);

  function submitSearch() {
    setQuery(search.trim());
    setOffset(0);
    setAttempt(current => current + 1);
  }

  return <section className="migration-content-review" aria-label="변환된 업무·문서" aria-busy={!page && !busy}>
    <form className="migration-content-filters" onSubmit={event => { event.preventDefault(); submitSearch(); }}>
      <label>원본 패키지<select className="field" value={packageId} disabled={busy} onChange={event => {
        setPackageId(event.currentTarget.value);
        setOffset(0);
      }}>
        <option value="">모든 원본 패키지</option>
        {sources.map(source => <option key={source.id} value={source.id}>{source.filename}</option>)}
      </select></label>
      <label>업무·문서 검색<input className="field" value={search} onChange={event => setSearch(event.currentTarget.value)}
        placeholder="제목, 원본 ID 또는 Jira 키" disabled={busy} maxLength={200} /></label>
      <button type="submit" className="btn" disabled={busy}><Search size={15} aria-hidden="true" />검색</button>
    </form>
    {!busy && !page && <p role="status">변환된 업무와 문서를 불러오는 중…</p>}
    {!busy && page && 'error' in page && <div>
      <p className="migration-error" role="alert">{page.error}</p>
      <button type="button" className="btn" onClick={() => setAttempt(current => current + 1)}>목록 다시 불러오기</button>
    </div>}
    {visiblePage?.total === 0 && <p role="status">조건에 맞는 변환 결과가 없습니다.</p>}
    {!!visiblePage?.rows.length && <ul className="migration-content-list">
      {visiblePage.rows.map(row => <li key={row.recordId}>
        <div>
          <strong>{row.title}</strong>
          <small>{filenames.get(row.packageId)} · {row.sourceKey ?? row.sourceId}</small>
          <small>{row.targetType === 'issue' ? '업무' : '문서'} · {row.change === 'update' ? '본문 변경' : '새 항목'}</small>
        </div>
        <button type="button" className="btn" aria-label={`변환 결과 보기 ${row.title}`} disabled={busy}
          onClick={event => setInspection({ row, opener: event.currentTarget })}>
          <FileSearch size={15} aria-hidden="true" />변환 결과 보기
        </button>
      </li>)}
    </ul>}
    {(visiblePage?.total ?? lastTotal) > 0 && <nav className="migration-pagination" aria-label="변환 결과 페이지">
      <span role="status">{visiblePage ? `${offset + 1}–${offset + visiblePage.rows.length} / ${visiblePage.total.toLocaleString()}건` : ''}</span>
      <button type="button" className="btn btn-ghost" aria-disabled={!canGoBack} onClick={() => { if (canGoBack) setOffset(offset - PAGE_SIZE); }}>이전</button>
      <button type="button" className="btn btn-ghost" aria-disabled={!canGoForward} onClick={() => { if (canGoForward) setOffset(offset + PAGE_SIZE); }}>다음</button>
    </nav>}
    {inspection && !busy && <MigrationContentDialog inspection={inspection} path={path} actorId={actorId} version={version} data={data}
      filename={filenames.get(inspection.row.packageId)} onClose={() => setInspection(null)} />}
  </section>;
}

function MigrationContentDialog({ inspection, path, actorId, version, data, filename, onClose }: {
  inspection: Inspection; path: string; actorId: string; version: string; data: WorkspaceSnapshot; filename?: string; onClose: () => void;
}) {
  const { row, opener } = inspection;
  const title = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [originalAttempt, setOriginalAttempt] = useState(0);
  const [showOriginal, setShowOriginal] = useState(false);
  const [detail, setDetail] = useState<Result<MigrationContentReviewDetail> | null>(null);
  const [original, setOriginal] = useState<Result<LegacyRecord> | null>(null);
  const legacyRecordId = row.recordId.startsWith(`${row.packageId}/`) ? row.recordId.slice(row.packageId.length + 1) : '';

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      dialog.close();
      if (opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [opener]);

  useEffect(() => {
    const params = new URLSearchParams({ expectedVersion: version, recordId: row.recordId });
    return read<MigrationContentReviewDetail>(`${path}/detail?${params}`, actorId, response => {
      if ('value' in response && (response.value.recordId !== row.recordId || response.value.packageId !== row.packageId ||
          response.value.targetType !== row.targetType || response.value.sourceId !== row.sourceId)) {
        return setDetail({ error: '선택한 원본과 변환 결과가 일치하지 않습니다.' });
      }
      setDetail(response);
    });
  }, [actorId, attempt, path, row, version]);

  useEffect(() => {
    if (!showOriginal || original || !legacyRecordId) return;
    const route = `/legacy-import/packages/${encodeURIComponent(row.packageId)}/records/${encodeURIComponent(legacyRecordId)}`;
    return read<LegacyRecord>(route, actorId, response => {
      if ('value' in response && (response.value.id !== legacyRecordId || response.value.sourceId !== row.sourceId)) {
        return setOriginal({ error: '선택한 원본을 확인할 수 없습니다.' });
      }
      setOriginal(response);
    });
  }, [actorId, legacyRecordId, original, originalAttempt, row.packageId, row.sourceId, showOriginal]);

  return <dialog ref={dialogRef} aria-labelledby={title} className="migration-original-dialog migration-content-dialog"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="migration-original-heading">
      <div><h3 id={title}>변환 결과 · {row.title}</h3><p>{[filename, row.sourceKey ?? row.sourceId].filter(Boolean).join(' · ')}</p></div>
      <button ref={closeRef} type="button" className="btn btn-ghost" onClick={onClose}><X size={16} aria-hidden="true" />닫기</button>
    </header>
    {!detail && <p role="status">변환 결과를 불러오는 중…</p>}
    {detail && 'error' in detail && <div>
      <p className="migration-error" role="alert">{detail.error}</p>
      <button type="button" className="btn" onClick={() => {
        closeRef.current?.focus({ preventScroll: true });
        setDetail(null);
        setAttempt(current => current + 1);
      }}>변환 결과 다시 불러오기</button>
    </div>}
    {detail && 'value' in detail && <>
      {legacyRecordId && <button type="button" className="btn migration-content-toggle" onClick={() => setShowOriginal(current => !current)}>
        {showOriginal ? '변환 결과 보기' : '원본 보기'}
      </button>}
      {showOriginal ? <>
        {!original && <p role="status">원본 객체를 불러오는 중…</p>}
        {original && 'error' in original && <div>
          <p className="migration-error" role="alert">{original.error}</p>
          <button type="button" className="btn" onClick={() => {
            closeRef.current?.focus({ preventScroll: true });
            setOriginal(null);
            setOriginalAttempt(current => current + 1);
          }}>원본 다시 불러오기</button>
        </div>}
        {original && 'value' in original && <LegacyRecordDetail record={original.value} />}
      </> : <ConvertedContent value={detail.value} data={data} />}
    </>}
  </dialog>;
}

function ConvertedContent({ value, data }: { value: MigrationContentReviewDetail; data: WorkspaceSnapshot }) {
  return <div className="migration-content-body">
    {value.schedule && <p>일정 · {value.schedule.startDate ?? '시작일 미정'} ~ {value.schedule.endDate ?? '종료일 미정'}</p>}
    {value.sourceUrl && <p className="migration-content-source"><small>연결할 원본 주소</small><code>{value.sourceUrl}</code></p>}
    {value.targetType === 'document' && value.content && <section aria-label="변환된 문서">
      <DocumentBlocksProvider data={data} documentId={null} openIssue={keepReading} openDocument={keepReading}>
        <ReadonlyDocumentContent content={value.content} mode="preview" />
      </DocumentBlocksProvider>
    </section>}
    {value.targetType === 'issue' && <ReadonlyIssueDescription value={value.description ?? ''} format={value.descriptionFormat ?? 'plain'} inertLinks />}
  </div>;
}
