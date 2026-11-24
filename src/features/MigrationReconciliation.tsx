'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, ClipboardCheck, FileCheck2, RefreshCw, Search } from 'lucide-react';
import type {
  FeatureProps, LegacyRecordKind, SourceImport, SourceReconciliationFileCheck, SourceReconciliationPage,
  SourceReconciliationRow, SourceReconciliationStatus, SourceReconciliationTarget, SourceRecordArchive,
} from '../../shared/types';
import { api } from '../lib/api';
import { MigrationReceiptAudit, reconciliationPackageIdentity, type PrimaryRecordDrill } from './MigrationReceiptAudit';
import { SourceArchiveDetail, sourceRecordKindLabels } from './SourceOrigins';

const PAGE_SIZE = 30;
const statusLabels: Record<SourceReconciliationStatus, string> = {
  linked: '연결됨', trashed: '휴지통', missing: '현재 대상 없음', 'archive-only': '원본 보관', excluded: '이관 제외',
};
const targetLabels: Record<SourceReconciliationTarget['type'], string> = {
  project: '프로젝트', issue: '업무', document: '문서', comment: '댓글', revision: '문서 버전', attachment: '첨부 버전', worklog: '작업 시간',
};
const fileLabels: Record<SourceReconciliationFileCheck['status'], string> = {
  verified: 'SHA-256 일치', missing: '파일 누락', corrupt: '파일 크기 또는 SHA-256 불일치',
  unbound: '이관된 파일 버전이 없습니다.',
};

type Filters = {
  packageId: string; status: SourceReconciliationStatus | ''; kind: LegacyRecordKind | '';
  finding: NonNullable<PrimaryRecordDrill['finding']> | ''; q: string; offset: number;
};
type PageLoad = { filters: Filters; data: SourceReconciliationPage } | { filters: Filters; error: string };
type Destination = NonNullable<SourceReconciliationTarget['owner']>;
type Props = Pick<FeatureProps, 'data' | 'openIssue' | 'openDocument' | 'refresh' | 'notify'> & {
  sourceImportId: string; packages: SourceImport['packages'];
};
type RecordArea = 'list' | 'audit' | 'jira-audit';
type RecordLoad = { sourceRecordId: string; area: RecordArea } & ({ pending: true } | { archive: SourceRecordArchive } | { error: string });

export function MigrationReconciliation(props: Props) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return <div className="migration-reconciliation-entry">
    <button type="button" className="btn" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}>
      <ClipboardCheck size={16} aria-hidden="true" />이관 결과 대조
    </button>
    <div id={panelId}>{open && <ReconciliationPanel {...props} />}</div>
  </div>;
}

function ReconciliationPanel({ sourceImportId, packages, data, openIssue, openDocument, refresh, notify }: Props) {
  const [filters, setFilters] = useState<Filters>({ packageId: '', status: '', kind: '', finding: '', q: '', offset: 0 });
  const [searchDraft, setSearchDraft] = useState('');
  const [load, setLoad] = useState<PageLoad | null>(null);
  const [receiptVersion, setReceiptVersion] = useState<number | null>(null);
  const [record, setRecord] = useState<RecordLoad | null>(null);
  const recordRequest = useRef<AbortController | null>(null);
  const recordButton = useRef<HTMLButtonElement | null>(null);
  const headingId = useId();
  const listId = useId();
  const listHeading = useRef<HTMLHeadingElement | null>(null);
  const base = `/source-imports/${encodeURIComponent(sourceImportId)}`;
  const result = load?.filters === filters && 'data' in load ? load.data : null;
  const error = load?.filters === filters && 'error' in load ? load.error : null;
  const loading = load?.filters !== filters;
  const auditRecord = record?.area === 'audit' ? record : null;
  const jiraRecord = record?.area === 'jira-audit' ? record : null;

  useEffect(() => {
    const abort = new AbortController();
    const params = new URLSearchParams({ offset: String(filters.offset), limit: String(PAGE_SIZE) });
    if (filters.packageId) params.set('packageId', filters.packageId);
    if (filters.status) params.set('status', filters.status);
    if (filters.kind) params.set('kind', filters.kind);
    if (filters.finding) params.set('finding', filters.finding);
    if (filters.q) params.set('q', filters.q);
    void api<SourceReconciliationPage>(`${base}/reconciliation?${params}`, { signal: abort.signal, cache: 'no-store' })
      .then(data => {
        if (abort.signal.aborted) return;
        setReceiptVersion(data.receiptVersion);
        if (data.offset > 0 && data.offset >= data.total) {
          const lastPage = Math.floor(Math.max(0, data.total - 1) / PAGE_SIZE) * PAGE_SIZE;
          setFilters(current => current === filters ? { ...current, offset: lastPage } : current);
          return;
        }
        setLoad({ filters, data });
      })
      .catch(cause => {
        if (!abort.signal.aborted) setLoad({ filters, error: cause instanceof Error ? cause.message : '대조 결과를 불러오지 못했습니다.' });
      });
    return () => abort.abort();
  }, [base, filters]);
  useEffect(() => () => recordRequest.current?.abort(), []);

  function closeRecord(restoreFocus = false) {
    recordRequest.current?.abort();
    recordRequest.current = null;
    setRecord(null);
    if (restoreFocus) recordButton.current?.focus();
    recordButton.current = null;
  }
  function updateFilters(changes: Partial<Filters> = {}) {
    if (record?.area === 'list') closeRecord();
    setFilters(current => ({ ...current, ...changes }));
  }
  function drill({ packageId, kind, status, finding }: PrimaryRecordDrill) {
    setSearchDraft('');
    updateFilters({ packageId, kind, status: status ?? '', finding: finding ?? '', q: '', offset: 0 });
    listHeading.current?.focus();
  }
  function changePackage(packageId: string) {
    updateFilters({ packageId, finding: '', offset: 0 });
  }
  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    updateFilters({ q: searchDraft.trim(), offset: 0 });
  }
  async function openRecord(sourceRecordId: string, area: RecordArea, trigger: HTMLButtonElement) {
    recordRequest.current?.abort();
    const abort = new AbortController();
    recordRequest.current = abort;
    recordButton.current = trigger;
    setRecord({ sourceRecordId, area, pending: true });
    try {
      const archive = await api<SourceRecordArchive>(`${base}/records/${encodeURIComponent(sourceRecordId)}`, { signal: abort.signal, cache: 'no-store' });
      if (!abort.signal.aborted) setRecord({ sourceRecordId, area, archive });
    } catch (cause) {
      if (!abort.signal.aborted) setRecord({ sourceRecordId, area, error: cause instanceof Error ? cause.message : '보존 원본을 불러오지 못했습니다.' });
    }
  }
  function toggleAuditRecord(sourceRecordId: string, area: Exclude<RecordArea, 'list'>, trigger: HTMLButtonElement) {
    if (record?.area === area && record.sourceRecordId === sourceRecordId) closeRecord();
    else void openRecord(sourceRecordId, area, trigger);
  }

  return <section className="migration-reconciliation" aria-labelledby={headingId}>
    <header className="migration-reconciliation-heading">
      <div>
        <h3 id={headingId}>이관 결과 대조</h3>
        <p>보존 원본과 현재 대상을 함께 확인합니다. 첨부는 파일을 읽어 크기와 SHA-256을 확인할 수 있습니다.</p>
      </div>
      <button type="button" className="btn btn-ghost" aria-label="이관 결과 대조 새로고침" disabled={loading} onClick={() => updateFilters()}>
        <RefreshCw size={16} aria-hidden="true" />새로고침
      </button>
    </header>

    <MigrationReceiptAudit key={`${base}:${receiptVersion ?? ''}`} base={base} receiptVersion={receiptVersion}
      canStart={Boolean(result)} recordLabels={statusLabels} packages={packages} primaryListId={listId} onPrimaryDrill={drill}
      onStale={() => updateFilters()}
      detail={{
        openId: auditRecord?.sourceRecordId ?? null,
        onToggle: (sourceRecordId, trigger) => toggleAuditRecord(sourceRecordId, 'audit', trigger),
        onClose: () => { if (auditRecord) closeRecord(); },
        content: auditRecord && <ReconciliationRecordDetail state={auditRecord} onClose={() => closeRecord(true)} />,
      }} jiraDetail={{
        openId: jiraRecord?.sourceRecordId ?? null,
        onToggle: (sourceRecordId, trigger) => toggleAuditRecord(sourceRecordId, 'jira-audit', trigger),
        onClose: () => { if (jiraRecord) closeRecord(); },
        content: jiraRecord && <ReconciliationRecordDetail state={jiraRecord} onClose={() => closeRecord(true)} />,
      }} />

    <section id={listId} aria-labelledby={`${listId}-heading`}>
      <h4 id={`${listId}-heading`} className="migration-reconciliation-list-heading" tabIndex={-1} ref={listHeading}>대조 원본 목록</h4>
      {result && <dl className="migration-reconciliation-counts" aria-label={filters.packageId ? '선택한 패키지 원본 대조 건수' : '전체 원본 대조 건수'}>
        {Object.entries(statusLabels).map(([status, label]) => <div key={status}>
          <dt>{label}</dt><dd>{result.counts[status as SourceReconciliationStatus].toLocaleString()}</dd>
        </div>)}
      </dl>}

      <form className="migration-reconciliation-filters" onSubmit={search}>
        {packages.length > 0 && <div className="migration-reconciliation-package-filter">
          <label>대조 원본 패키지
            <select className="field" aria-label="대조 원본 패키지" value={filters.packageId} onChange={event => changePackage(event.target.value)}>
              <option value="">전체 패키지</option>
              {packages.map(pkg => <option key={pkg.stagingId} value={pkg.stagingId}>{pkg.filename} · {reconciliationPackageIdentity(pkg)}</option>)}
            </select>
          </label>
          {filters.packageId && <button type="button" className="btn btn-ghost" onClick={() => {
            changePackage('');
            listHeading.current?.focus();
          }}>패키지 필터 해제</button>}
        </div>}
        <label>대조 상태
          <select className="field" aria-label="대조 상태" value={filters.status}
            onChange={event => updateFilters({ status: event.target.value as Filters['status'], finding: '', offset: 0 })}>
            <option value="">전체 상태</option>
            {Object.entries(statusLabels).map(([status, label]) => <option key={status} value={status}>{label}</option>)}
          </select>
        </label>
        <label>대조 원본 종류
          <select className="field" aria-label="대조 원본 종류" value={filters.kind}
            onChange={event => updateFilters({ kind: event.target.value as Filters['kind'], finding: '', offset: 0 })}>
            <option value="">전체 종류</option>
            {Object.entries(sourceRecordKindLabels).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
          </select>
        </label>
        <label>대조 검색
          <input type="search" className="field" value={searchDraft} onChange={event => setSearchDraft(event.target.value)} maxLength={300} placeholder="제목·원본 키·ID" />
        </label>
        <button type="submit" className="btn" aria-label="대조 검색 실행"><Search size={16} aria-hidden="true" />검색</button>
        {filters.finding && <div className="migration-reconciliation-finding-filter">
          <span className="migration-audit-status is-mismatch">대상 연결 오류만</span>
          <button type="button" className="btn btn-ghost" onClick={() => {
            updateFilters({ finding: '', offset: 0 });
            listHeading.current?.focus();
          }}>대상 연결 오류 필터 해제</button>
        </div>}
      </form>

      {loading && <p role="status">이관 결과를 대조하는 중…</p>}
      {error && <p role="alert" className="migration-error">{error}</p>}
      {result && (result.rows.length ? <>
        <ul className="migration-reconciliation-list" aria-label="이관 결과 대조 목록">
          {result.rows.map(row => {
            const selectedRecord = record?.area === 'list' && record.sourceRecordId === row.sourceRecordId ? record : null;
            return <li className="migration-reconciliation-row" key={row.sourceRecordId}>
              <div className="migration-reconciliation-source">
                <small>{sourceRecordKindLabels[row.kind]} · {row.product === 'jira' ? 'Jira' : 'Confluence'} / {row.sourceInstance}</small>
                <strong>{row.title || '(제목 없음)'}</strong>
                <small>원본 {row.sourceKey && row.sourceKey !== row.sourceId ? `${row.sourceKey} · ` : ''}{row.sourceId}</small>
                <button type="button" className="btn btn-ghost" aria-expanded={Boolean(selectedRecord)} onClick={event => {
                  if (selectedRecord) closeRecord(); else void openRecord(row.sourceRecordId, 'list', event.currentTarget);
                }}>보존 원본 열기</button>
              </div>
              <div className="migration-reconciliation-target">
                <span className={`migration-reconciliation-status is-${row.status}`}>{statusLabels[row.status]}</span>
                {row.invalidPrimaryTarget && <span className="migration-audit-status is-mismatch">대상 연결 오류</span>}
                <Target row={row} data={data} openIssue={openIssue} openDocument={openDocument} refresh={refresh} notify={notify} />
                {row.kind === 'attachment' && row.target?.type === 'attachment' && <FileCheck base={base} row={row} />}
              </div>
              {selectedRecord && <div className="migration-reconciliation-record">
                <ReconciliationRecordDetail state={selectedRecord} onClose={() => closeRecord(true)} />
              </div>}
            </li>;
          })}
        </ul>
        <div className="migration-pagination">
          <span role="status">{result.offset + 1}–{Math.min(result.offset + result.limit, result.total)} / {result.total.toLocaleString()}개</span>
          <button type="button" className="btn btn-ghost" aria-label="이관 결과 대조 이전 페이지" disabled={!result.offset}
            onClick={() => updateFilters({ offset: Math.max(0, result.offset - result.limit) })}>이전</button>
          <button type="button" className="btn btn-ghost" aria-label="이관 결과 대조 다음 페이지" disabled={result.offset + result.limit >= result.total}
            onClick={() => updateFilters({ offset: result.offset + result.limit })}>다음</button>
        </div>
      </> : <p role="status">조건에 맞는 원본이 없습니다.</p>)}
    </section>
  </section>;
}

function ReconciliationRecordDetail({ state, onClose }: { state: RecordLoad; onClose: () => void }) {
  if ('pending' in state) return <p role="status">보존 원본을 불러오는 중…</p>;
  if ('error' in state) return <p role="alert" className="migration-error">{state.error}</p>;
  return <SourceArchiveDetail archive={state.archive} originalAuthorName={null} onClose={onClose} />;
}

function Target({ row, data, ...navigation }: Pick<Props, 'data' | 'openIssue' | 'openDocument' | 'refresh' | 'notify'> & { row: SourceReconciliationRow }) {
  const { target } = row;
  if (!target) return null;
  const direct = row.status === 'linked' && (target.type === 'issue' || target.type === 'document') ? { ...target, type: target.type } : null;
  const owner = target.owner?.id !== direct?.id ? target.owner : null;
  const destination = direct ?? owner;
  const project = data.projects.find(project => project.id === target.projectId);

  return <>
    <div className="migration-reconciliation-destination">
      <small>{targetLabels[target.type]}{project && target.type !== 'project' ? ` · ${project.name}` : ''}</small>
      <strong>{target.label}</strong>
    </div>
    {owner && <small>소유 {targetLabels[owner.type]} · {owner.label}</small>}
    {!row.invalidPrimaryTarget && destination && <DestinationAction destination={destination} data={data} {...navigation} />}
    {!row.invalidPrimaryTarget && row.status === 'linked' && target.type === 'project' && project && <a className="btn btn-ghost" href={`#/${encodeURIComponent(project.id)}/overview`}>
      <ArrowUpRight size={15} aria-hidden="true" />현재 프로젝트 열기
    </a>}
  </>;
}

function DestinationAction({ destination, data, openIssue, openDocument, refresh, notify }: Pick<Props, 'data' | 'openIssue' | 'openDocument' | 'refresh' | 'notify'> & { destination: Destination }) {
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  const label = `현재 ${targetLabels[destination.type]} 열기`;
  useEffect(() => () => request.current?.abort(), []);

  async function navigate() {
    const open = destination.type === 'issue' ? openIssue : openDocument;
    const current = (destination.type === 'issue' ? data.issues : data.documents).find(record => record.id === destination.id);
    if (current?.projectId === destination.projectId) { open(destination.id); return; }
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    setLoading(true);
    try {
      await refresh();
      if (!abort.signal.aborted) open(destination.id);
    } catch (cause) {
      if (!abort.signal.aborted) notify(cause instanceof Error ? cause.message : '현재 대상을 열지 못했습니다.', 'error');
    } finally {
      if (!abort.signal.aborted) setLoading(false);
    }
  }

  return <button type="button" className="btn btn-ghost" aria-label={`${label} ${destination.label}`} disabled={loading} onClick={() => void navigate()}>
    <ArrowUpRight size={15} aria-hidden="true" />{label}
  </button>;
}

function FileCheck({ base, row }: { base: string; row: SourceReconciliationRow }) {
  const [result, setResult] = useState<SourceReconciliationFileCheck | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function check() {
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    setResult(null);
    setError('');
    setLoading(true);
    try {
      const value = await api<SourceReconciliationFileCheck>(`${base}/records/${encodeURIComponent(row.sourceRecordId)}/check-file`, { signal: abort.signal, cache: 'no-store' });
      if (!abort.signal.aborted) setResult(value);
    } catch (cause) {
      if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : '첨부 파일을 확인하지 못했습니다.');
    } finally {
      if (!abort.signal.aborted) setLoading(false);
    }
  }

  return <div className="migration-reconciliation-file">
    <button type="button" className="btn btn-ghost" aria-label={`첨부 파일 확인 ${row.title || row.sourceId}`} disabled={loading} onClick={() => void check()}>
      <FileCheck2 size={16} aria-hidden="true" />첨부 파일 확인
    </button>
    {loading && <p role="status">첨부 파일 확인 중…</p>}
    {error && <p role="alert" className="migration-error">{error}</p>}
    {result && <div className={`migration-reconciliation-file-result is-${result.status}`} role="status">
      <strong>{fileLabels[result.status]}</strong>
      {result.size !== null && result.sha256 && <small>
        {result.status === 'verified' ? '확인한 파일' : '저장된 기준'} · {result.size.toLocaleString()} 바이트 · <code>{result.sha256}</code>
      </small>}
    </div>}
  </div>;
}
