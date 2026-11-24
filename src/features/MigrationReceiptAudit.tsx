'use client';

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ClipboardCheck, Download, FileSearch, Loader2 } from 'lucide-react';
import type {
  SourceImport, SourceReconciliationAudit, SourceReconciliationAuditStatus, SourceReconciliationIntegrity, SourceReconciliationIntegrityPackage,
  SourceReconciliationJiraFinding, SourceReconciliationJiraStatusFinding, SourceReconciliationJiraStatusFindingsPage,
  SourceReconciliationJiraStatusHistory, SourceReconciliationPrimaryRecords, SourceReconciliationStatus, User,
} from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { MigrationAuthorAudit } from './MigrationAuthorReview';
import { MigrationJiraRelationAudit } from './MigrationJiraRelationAudit';
import { MigrationResourceLinkAudit } from './MigrationResourceLinkAudit';
import { downloadDocument } from './document-utils';
import './migration-receipt-audit.css';

const PAGE_SIZE = 20;
const fileLabels: Record<SourceReconciliationAuditStatus, string> = {
  verified: 'SHA-256 일치',
  missing: '파일 누락',
  corrupt: '크기 또는 SHA-256 불일치',
  unbound: '연결된 파일 없음',
  excluded: '이관 제외',
  unreadable: '읽기 실패',
};
const findingStatuses = new Set<SourceReconciliationAuditStatus>(['missing', 'corrupt', 'unbound', 'unreadable']);
const integrityLabels: Record<SourceReconciliationIntegrity['status'], string> = {
  verified: '보존 원본 검증값 일치',
  mismatch: '확인 필요',
  'counts-only': '건수만 비교',
  unavailable: '비교 기준 없음',
};
const primaryRecordLabels = { issue: 'Jira 업무', page: 'Confluence 페이지' } as const;
const jiraHistoryLabels = {
  sourceChanges: '보존 원본의 변경',
  projected: '현재 업무에 표시',
  duplicate: '중복 변경',
  excluded: '이관 제외',
  restricted: '표시 제한',
  unavailable: '표시 대상 확인 필요',
};
const jiraFindingLabels: Record<SourceReconciliationJiraFinding, string> = {
  unavailable: jiraHistoryLabels.unavailable,
  restricted: jiraHistoryLabels.restricted,
  excluded: jiraHistoryLabels.excluded,
  'unresolved-time': '시각 미확인',
  'unresolved-author': '작성자 미확인',
};
const jiraUnavailableLabels: Record<NonNullable<SourceReconciliationJiraStatusFinding['reason']>, string> = {
  'issue-in-trash': '대상 업무가 휴지통에 있습니다.',
  'issue-unavailable': '현재 대상 업무를 찾을 수 없습니다.',
  'ownership-unverified': '원본 변경의 업무 연결을 확인할 수 없습니다.',
};

type Filter = 'all' | 'findings' | SourceReconciliationAuditStatus;
type AuditState = { kind: 'idle' | 'pending' | 'cancelled' } | { kind: 'complete'; result: SourceReconciliationAudit } | { kind: 'error'; message: string };
export type AuditDetail = {
  openId: string | null;
  content: ReactNode;
  onToggle: (id: string, trigger: HTMLButtonElement) => void;
  onClose: () => void;
};
export type PrimaryRecordDrill = Pick<SourceReconciliationPrimaryRecords, 'packageId' | 'kind'> & (
  { status: SourceReconciliationStatus; finding?: never } | { status?: never; finding: 'invalid-primary-target' }
);

export function reconciliationPackageIdentity({ source, sha256 }: SourceImport['packages'][number]) {
  return `${source.product === 'jira' ? 'Jira' : 'Confluence'} · ${source.instanceKey} · ${sha256.slice(0, 12)}`;
}

type AuditProps = {
  base: string;
  receiptVersion: number | null;
  canStart: boolean;
  recordLabels: Record<SourceReconciliationStatus, string>;
  packages: SourceImport['packages'];
  users: readonly User[];
  primaryListId: string;
  onPrimaryDrill: (drill: PrimaryRecordDrill) => void;
  onStale: () => void;
  openResourceLinkIssue?: (id: string) => void;
  openResourceLinkDocument?: (id: string) => void;
  canOpenResourceLinkEndpoint?: (kind: 'issue' | 'document', id: string) => boolean;
  detail: AuditDetail;
  jiraDetail: AuditDetail;
  relationDetail: AuditDetail;
  authorDetail: AuditDetail;
};

export function MigrationReceiptAudit({ base, receiptVersion, canStart, recordLabels, packages, users, primaryListId, onPrimaryDrill,
  onStale, openResourceLinkIssue, openResourceLinkDocument, canOpenResourceLinkEndpoint, detail, jiraDetail, relationDetail, authorDetail }: AuditProps) {
  const [state, setState] = useState<AuditState>({ kind: 'idle' });
  const [filter, setFilter] = useState<Filter>('all');
  const [offset, setOffset] = useState(0);
  const request = useRef<AbortController | null>(null);
  const startButton = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();
  const headingId = useId();
  const report = state.kind === 'complete' ? state.result : null;
  const rows = useMemo(() => {
    if (!report) return [];
    if (filter === 'all') return report.attachments;
    return report.attachments.filter(row => filter === 'findings' ? findingStatuses.has(row.status) : row.status === filter);
  }, [filter, report]);

  useEffect(() => () => request.current?.abort(), []);

  async function start() {
    if (!canStart || receiptVersion === null || request.current) return;
    const abort = new AbortController();
    request.current = abort;
    detail.onClose();
    jiraDetail.onClose();
    relationDetail.onClose();
    authorDetail.onClose();
    setState({ kind: 'pending' });
    try {
      const next = await api<SourceReconciliationAudit>(`${base}/reconciliation/audit?expectedVersion=${receiptVersion}`, { signal: abort.signal, cache: 'no-store' });
      if (abort.signal.aborted) return;
      setFilter([...findingStatuses].some(status => next.attachmentCounts[status] > 0) ? 'findings' : 'all');
      setOffset(0);
      setState({ kind: 'complete', result: next });
    } catch (cause) {
      if (abort.signal.aborted) return;
      if (cause instanceof ApiError && cause.status === 409) onStale();
      setState({ kind: 'error', message: cause instanceof Error ? cause.message : '이관 검증을 완료하지 못했습니다.' });
    } finally {
      if (request.current === abort) request.current = null;
    }
  }

  function cancel() {
    request.current?.abort();
    request.current = null;
    setState({ kind: 'cancelled' });
    requestAnimationFrame(() => startButton.current?.focus());
  }

  function restart() {
    startButton.current?.focus();
    void start();
  }

  function download(report: SourceReconciliationAudit) {
    const id = report.importId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    downloadDocument(`migration-audit-${id}.json`, JSON.stringify(report), 'application/json;charset=utf-8');
  }

  function changeOffset(next: number) {
    detail.onClose();
    setOffset(next);
  }

  return <div className="migration-audit-entry">
    <button ref={startButton} type="button" className="btn" aria-controls={state.kind !== 'idle' ? panelId : undefined}
      disabled={!canStart || state.kind === 'pending'} onClick={() => void start()}>
      <ClipboardCheck size={16} aria-hidden="true" />전체 이관 검증
    </button>
    {state.kind !== 'idle' && <section id={panelId} className="migration-audit" aria-labelledby={headingId}>
      <header className="migration-audit-heading">
        <div>
          <h4 id={headingId}>전체 이관 검증</h4>
          {report && <small>완료 <time dateTime={report.completedAt}>{new Date(report.completedAt).toLocaleString('ko-KR')}</time> · 영수증 버전 {report.receiptVersion}</small>}
        </div>
        {state.kind === 'pending' && <button type="button" className="btn btn-ghost" onClick={cancel}>검증 취소</button>}
        {report && <button type="button" className="btn btn-ghost" onClick={() => download(report)}>
          <Download size={16} aria-hidden="true" />검증 결과 JSON 내보내기
        </button>}
      </header>

      {state.kind === 'pending' && <p className="migration-pending" role="status"><Loader2 className="spin" size={17} aria-hidden="true" />원본 연결과 첨부 파일을 검증하는 중…</p>}
      {state.kind === 'cancelled' && <p role="status">전체 이관 검증을 취소했습니다.</p>}
      {state.kind === 'error' && <p className="migration-error" role="alert">{state.message}</p>}
      {report && <>
        <p className="migration-audit-completed" role="status">원본 연결과 첨부 검증을 마쳤습니다.</p>
        <ReceiptIntegrity integrity={report.integrity} />
        <PrimaryRecordCoverage records={report.primaryRecords} packages={packages} integrityPackages={report.integrity.packages}
          recordLabels={recordLabels} primaryListId={primaryListId} onDrill={onPrimaryDrill} />
        <MigrationAuthorAudit report={report.authorAttribution ?? null} base={base} receiptVersion={report.receiptVersion}
          packages={packages} users={users} detail={authorDetail} onRestart={restart} />
        {report.jiraStatusHistory && <JiraStatusHistoryAudit history={report.jiraStatusHistory} integrity={report.integrity.status}
          base={base} receiptVersion={report.receiptVersion} detail={jiraDetail} />}
        {report.jiraRelationProjection && <MigrationJiraRelationAudit projection={report.jiraRelationProjection}
          base={base} importId={report.importId} receiptVersion={report.receiptVersion} detail={relationDetail} onRestart={restart} />}
        {report.resourceLinkProjection && <MigrationResourceLinkAudit projection={report.resourceLinkProjection}
          base={base} importId={report.importId} receiptVersion={report.receiptVersion} onRestart={restart}
          openIssue={openResourceLinkIssue} openDocument={openResourceLinkDocument} canOpenEndpoint={canOpenResourceLinkEndpoint} />}
        <h5>원본 객체 상태</h5>
        <AuditCounts label="원본 검증 건수" labels={recordLabels} counts={report.recordCounts} />
        <h5>첨부 검증 결과</h5>
        <AuditCounts label="첨부 검증 건수" labels={fileLabels} counts={report.attachmentCounts} />
        {report.attachments.length > 0 && <>
          <label className="migration-audit-filter">첨부 검증 상태
            <select className="field" aria-label="첨부 검증 상태" value={filter} onChange={event => {
              setFilter(event.target.value as Filter);
              changeOffset(0);
            }}>
              <option value="findings">확인 필요</option>
              <option value="all">전체 파일</option>
              {Object.entries(fileLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </label>
          {rows.length ? <>
            <ul className="migration-reconciliation-list" aria-label="첨부 검증 목록">
              {rows.slice(offset, offset + PAGE_SIZE).map(row => <li className="migration-reconciliation-row" key={row.sourceRecordId}>
                <div className="migration-reconciliation-source">
                  <small>{row.product === 'jira' ? 'Jira' : 'Confluence'} · {row.sourceInstance}</small>
                  <strong>{row.title || row.sourceId}</strong>
                  <small>원본 {row.sourceId}</small>
                  <small>원본 패키지 SHA-256 <code>{row.packageSha256}</code></small>
                  <button type="button" className="btn btn-ghost" aria-label={`검증 원본 ${row.sourceId} 열기`}
                    aria-expanded={detail.openId === row.sourceRecordId} onClick={event => detail.onToggle(row.sourceRecordId, event.currentTarget)}>
                    <FileSearch size={15} aria-hidden="true" />보존 원본 보기
                  </button>
                </div>
                <div className="migration-reconciliation-target">
                  <span className={`migration-audit-status is-${row.status}`}>{fileLabels[row.status]}</span>
                  <small>{recordLabels[row.recordStatus]}</small>
                  {row.fileId && <small>대상 파일 <code>{row.fileId}</code></small>}
                  {row.size !== null && <small>{row.size.toLocaleString('ko-KR')} 바이트</small>}
                  {row.sha256 && <small>기준 SHA-256 <code>{row.sha256}</code></small>}
                </div>
                {detail.openId === row.sourceRecordId && <div className="migration-reconciliation-record">{detail.content}</div>}
              </li>)}
            </ul>
            <div className="migration-pagination">
              <span role="status">{offset + 1}–{Math.min(offset + PAGE_SIZE, rows.length)} / {rows.length.toLocaleString('ko-KR')}개</span>
              <button type="button" className="btn btn-ghost" aria-label="첨부 검증 이전 페이지" disabled={!offset}
                onClick={() => changeOffset(Math.max(0, offset - PAGE_SIZE))}>이전</button>
              <button type="button" className="btn btn-ghost" aria-label="첨부 검증 다음 페이지" disabled={offset + PAGE_SIZE >= rows.length}
                onClick={() => changeOffset(offset + PAGE_SIZE)}>다음</button>
            </div>
          </> : <p>선택한 상태의 첨부가 없습니다.</p>}
        </>}
        {report.attachments.length === 0 && <p>현재 검사할 첨부 원본이 없습니다.</p>}
      </>}
    </section>}
  </div>;
}

function PrimaryRecordCoverage({ records, packages, integrityPackages, recordLabels, primaryListId, onDrill }: {
  records: SourceReconciliationAudit['primaryRecords'];
  packages: SourceImport['packages'];
  integrityPackages: SourceReconciliationIntegrityPackage[];
  recordLabels: Record<SourceReconciliationStatus, string>;
  primaryListId: string;
  onDrill: AuditProps['onPrimaryDrill'];
}) {
  if (!records?.length) return null;
  const packagesById = new Map(packages.map(item => [item.stagingId, item]));
  const names = new Map(integrityPackages.map(item => [item.stagingId, item.filename]));
  const labels = { ...recordLabels, 'archive-only': '원본 보관만' };
  return <section className="migration-audit-integrity migration-audit-primary-records" aria-label="이관 티켓·문서 대조">
    <div className="migration-audit-integrity-heading"><h5>이관 티켓·문서 대조</h5></div>
    <ul className="migration-audit-integrity-packages" aria-label="원본 패키지별 티켓·문서">
      {records.map(({ packageId, kind, counts, invalidTargets }) => {
        const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
        const needsReview = counts['archive-only'] > 0 || counts.missing > 0 || counts.trashed > 0;
        const pkg = packagesById.get(packageId);
        const invalidLabel = `대상 연결 오류 ${count(invalidTargets)}`;
        return <li key={packageId}>
          <div className="migration-audit-integrity-heading">
            <strong>{pkg?.filename ?? names.get(packageId) ?? packageId}</strong>
            {pkg && <small>{reconciliationPackageIdentity(pkg)}</small>}
            <span>{primaryRecordLabels[kind]} {count(total)}</span>
            {invalidTargets > 0 && (pkg ? <button type="button" className="migration-audit-drill migration-audit-status is-mismatch"
              aria-label={`${invalidLabel} 보기`} aria-controls={primaryListId}
              onClick={() => onDrill({ packageId, kind, finding: 'invalid-primary-target' })}>{invalidLabel}</button>
              : <span className="migration-audit-status is-mismatch">{invalidLabel}</span>)}
            {invalidTargets === 0 && needsReview && <span className="migration-audit-status is-unbound">확인 필요</span>}
          </div>
          <AuditCounts label={`${primaryRecordLabels[kind]} 상태별 건수`} labels={labels} counts={counts}
            drill={pkg ? { controls: primaryListId, select: status => onDrill({ packageId, kind, status }) } : undefined} />
        </li>;
      })}
    </ul>
  </section>;
}

function JiraStatusHistoryAudit({ history, integrity, base, receiptVersion, detail }: {
  history: SourceReconciliationJiraStatusHistory;
  integrity: SourceReconciliationIntegrity['status'];
  base: string;
  receiptVersion: number;
  detail: AuditDetail;
}) {
  const [open, setOpen] = useState(false);
  const reviewButton = useRef<HTMLButtonElement | null>(null);
  const findingsId = useId();
  const { sourceChanges, projected, duplicate, excluded, restricted, unavailable, unresolvedTime, unresolvedAuthor } = history;
  const needsReview = integrity !== 'verified' || [restricted, unavailable, unresolvedTime, unresolvedAuthor].some(value => value > 0);
  const reviewedCounts: Record<SourceReconciliationJiraFinding, number> = {
    unavailable, restricted, excluded, 'unresolved-time': unresolvedTime, 'unresolved-author': unresolvedAuthor,
  };
  const initialFinding = (Object.keys(jiraFindingLabels) as SourceReconciliationJiraFinding[]).find(finding => reviewedCounts[finding] > 0);

  function close() {
    detail.onClose();
    setOpen(false);
    requestAnimationFrame(() => reviewButton.current?.focus());
  }

  return <section className="migration-audit-integrity" aria-label="Jira 상태 변경 검증">
    <div className="migration-audit-integrity-heading">
      <h5>Jira 상태 변경 검증</h5>
      {needsReview && <span className="migration-audit-status is-mismatch">확인 필요</span>}
    </div>
    {integrity !== 'verified' && <p>이 집계를 사용하기 전에 이관 당시 기록과 현재 비교 결과를 확인해 주세요.</p>}
    {sourceChanges > 0
      ? <AuditCounts label="Jira 상태 변경 건수" labels={jiraHistoryLabels}
        counts={{ sourceChanges, projected: projected.count, duplicate, excluded, restricted, unavailable }} />
      : <p>보존 원본에서 확인한 상태 변경은 0건입니다. Jira 내보내기에 변경 이력이 포함되어 있는지 확인해 주세요.</p>}
    {(unresolvedTime > 0 || unresolvedAuthor > 0) && <p>현재 표시된 변경 중 시각 미확인 {count(unresolvedTime)} · 작성자 미확인 {count(unresolvedAuthor)}</p>}
    {initialFinding && <button ref={reviewButton} type="button" className="btn btn-ghost" aria-expanded={open}
      aria-controls={open ? findingsId : undefined} onClick={() => open ? close() : setOpen(true)}>{open ? '확인할 Jira 변경 접기' : '확인할 Jira 변경 열기'}</button>}
    {open && initialFinding && <JiraStatusHistoryFindings id={findingsId} base={base} receiptVersion={receiptVersion}
      initialFinding={initialFinding} reviewedCounts={reviewedCounts} detail={detail} onClose={close} />}
  </section>;
}

type JiraFindingQuery = { finding: SourceReconciliationJiraFinding; offset: number; expectedFingerprint?: string };
type JiraFindingsLoad = { query: JiraFindingQuery } & ({ data: SourceReconciliationJiraStatusFindingsPage } | { error: string; stale: boolean });

function JiraStatusHistoryFindings({ id, base, receiptVersion, initialFinding, reviewedCounts, detail, onClose }: {
  id: string;
  base: string;
  receiptVersion: number;
  initialFinding: SourceReconciliationJiraFinding;
  reviewedCounts: Record<SourceReconciliationJiraFinding, number>;
  detail: AuditDetail;
  onClose: () => void;
}) {
  const [query, setQuery] = useState<JiraFindingQuery>({ finding: initialFinding, offset: 0 });
  const [loaded, setLoaded] = useState<JiraFindingsLoad | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const headingId = useId();
  const response = loaded?.query === query ? loaded : null;
  const page = response && 'data' in response ? response.data : null;
  const error = response && 'error' in response ? response : null;

  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    const abort = new AbortController();
    const params = new URLSearchParams({ expectedVersion: String(receiptVersion), finding: query.finding, offset: String(query.offset), limit: String(PAGE_SIZE) });
    if (query.expectedFingerprint) params.set('expectedFingerprint', query.expectedFingerprint);
    void api<SourceReconciliationJiraStatusFindingsPage>(`${base}/reconciliation/jira-status-findings?${params}`, { signal: abort.signal, cache: 'no-store' })
      .then(data => { if (!abort.signal.aborted) setLoaded({ query, data }); })
      .catch(cause => {
        if (abort.signal.aborted) return;
        const stale = cause instanceof ApiError && cause.status === 409;
        const message = stale ? 'Jira 변경 목록이 바뀌었습니다. 다시 조회하거나 전체 이관 검증을 다시 실행해 주세요.'
          : cause instanceof Error ? cause.message : 'Jira 변경 목록을 불러오지 못했습니다.';
        setLoaded({ query, error: message, stale });
      });
    return () => abort.abort();
  }, [base, receiptVersion, query]);

  function load(next: JiraFindingQuery) {
    detail.onClose();
    setQuery(next);
  }
  function paginate(offset: number, fingerprint: string) {
    heading.current?.focus();
    load({ finding: query.finding, offset, expectedFingerprint: fingerprint });
  }

  return <section id={id} className="migration-audit-findings" aria-labelledby={headingId}>
    <div className="migration-audit-heading">
      <h6 id={headingId} ref={heading} tabIndex={-1}>확인할 Jira 변경</h6>
      <button type="button" className="btn btn-ghost" onClick={onClose}>확인 목록 닫기</button>
    </div>
    <label className="migration-audit-filter">확인할 Jira 변경 유형
      <select className="field" value={query.finding} onChange={event => load({ finding: event.target.value as SourceReconciliationJiraFinding, offset: 0 })}>
        {Object.entries(jiraFindingLabels).map(([finding, label]) => <option key={finding} value={finding}>{label}</option>)}
      </select>
    </label>
    {!response && <p role="status" className="migration-pending"><Loader2 size={15} className="spin" aria-hidden="true" />Jira 변경 목록을 불러오는 중…</p>}
    {error && <>
      <p role="alert" className="migration-error">{error.error}</p>
      <button type="button" className="btn btn-ghost" onClick={() => {
        heading.current?.focus();
        load(error.stale ? { finding: query.finding, offset: 0 } : { ...query });
      }}>{error.stale ? '처음부터 다시 조회' : 'Jira 변경 다시 조회'}</button>
    </>}
    {page && <>
      {page.totalChanges !== reviewedCounts[page.finding] && <p>전체 검증 시점과 현재의 변경 건수가 다릅니다. 전체 검증을 다시 실행해 비교할 수 있습니다.</p>}
      <p role="status">{jiraFindingLabels[page.finding]} {page.totalChanges.toLocaleString('ko-KR')}건 · 원본 {count(page.total)}</p>
      {page.rows.length > 0 ? <>
        <ul className="migration-reconciliation-list" aria-label="Jira 변경 원본 목록">
          {page.rows.map(row => <li key={row.sourceRecordId} className="migration-reconciliation-row">
            <div className="migration-reconciliation-source">
              <small>Jira · {row.sourceInstance}</small>
              <strong>원본 변경 {row.sourceId}</strong>
              {row.sourceIssueId && <small>원본 업무 {row.sourceIssueId}</small>}
              <button type="button" className="btn btn-ghost" aria-label={`Jira 변경 원본 ${row.sourceInstance} / ${row.sourceId} 열기`}
                aria-expanded={detail.openId === row.sourceRecordId} onClick={event => detail.onToggle(row.sourceRecordId, event.currentTarget)}>
                <FileSearch size={15} aria-hidden="true" />보존 원본 보기
              </button>
            </div>
            <div className="migration-reconciliation-target">
              <small>변경 {row.changeCount.toLocaleString('ko-KR')}건</small>
              {row.reason && <small>{jiraUnavailableLabels[row.reason]}</small>}
            </div>
            {detail.openId === row.sourceRecordId && <div className="migration-reconciliation-record">{detail.content}</div>}
          </li>)}
        </ul>
        {page.total > page.limit && <div className="migration-pagination">
          <span role="status">{page.offset + 1}–{page.offset + page.rows.length} / {count(page.total)}</span>
          <button type="button" className="btn btn-ghost" aria-label="Jira 변경 이전 페이지" disabled={!page.offset}
            onClick={() => paginate(Math.max(0, page.offset - page.limit), page.fingerprint)}>이전</button>
          <button type="button" className="btn btn-ghost" aria-label="Jira 변경 다음 페이지" disabled={page.offset + page.limit >= page.total}
            onClick={() => paginate(page.offset + page.limit, page.fingerprint)}>다음</button>
        </div>}
      </> : <p>선택한 유형에 해당하는 원본 변경이 없습니다.</p>}
    </>}
  </section>;
}

function ReceiptIntegrity({ integrity }: { integrity: SourceReconciliationIntegrity }) {
  const { status, packages, unmatchedRecords, columnMismatches } = integrity;
  const mismatches = packages.filter(item => item.status === 'mismatch');
  const remaining = packages.filter(item => item.status !== 'mismatch');
  const hasFingerprints = packages.some(item => item.recordsSha256.expected !== null);
  return <section className="migration-audit-integrity" aria-label="이관 당시 기록과 현재 비교">
    <div className="migration-audit-integrity-heading">
      <h5>이관 당시 기록과 현재 비교</h5>
      <span className={`migration-audit-status is-${status}`}>{integrityLabels[status]}</span>
    </div>
    {!hasFingerprints && <p>이 영수증에는 패키지별 검증값이 없습니다.</p>}
    <IntegrityCounts counts={integrity} label="영수증 전체 건수 비교" />
    {(unmatchedRecords > 0 || columnMismatches > 0) && <ul className="migration-audit-integrity-findings" aria-label="보존 원본 식별 정보 확인">
      {unmatchedRecords > 0 && <li>영수증의 패키지를 확인할 수 없는 원본 {count(unmatchedRecords)}</li>}
      {columnMismatches > 0 && <li>저장 식별 정보가 일치하지 않는 원본 {count(columnMismatches)}</li>}
    </ul>}
    {mismatches.length > 0 && <IntegrityPackages packages={mismatches} label="확인이 필요한 이관 패키지" />}
    {remaining.length > 0 && <details>
      <summary>패키지별 비교 {count(remaining.length)}</summary>
      <IntegrityPackages packages={remaining} label="이관 패키지별 비교" />
    </details>}
  </section>;
}

function IntegrityPackages({ packages, label }: { packages: SourceReconciliationIntegrityPackage[]; label: string }) {
  return <ul className="migration-audit-integrity-packages" aria-label={label}>
    {packages.map(item => {
      const { expected, observed } = item.recordsSha256;
      const comparison = expected === null ? '이관 당시 검증값 없음' : expected === observed ? '원본 목록 검증값 일치' : '원본 목록 검증값 불일치';
      return <li key={item.stagingId}>
        <div className="migration-audit-integrity-heading">
          <strong>{item.filename}</strong>
          {item.status === 'mismatch' && <span className="migration-audit-status is-mismatch">확인 필요</span>}
        </div>
        <IntegrityCounts counts={item} />
        <p>{comparison}</p>
      </li>;
    })}
  </ul>;
}

function IntegrityCounts({ counts, label }: { counts: Pick<SourceReconciliationIntegrity, 'records' | 'boundAttachments'>; label?: string }) {
  return <dl className="migration-audit-integrity-counts" aria-label={label}>
    <div><dt>보존 원본</dt><dd>{comparedCount(counts.records)}</dd></div>
    <div><dt>원본에 연결된 첨부 버전</dt><dd>{comparedCount(counts.boundAttachments)}</dd></div>
  </dl>;
}

function comparedCount({ expected, observed }: SourceReconciliationIntegrity['records']) {
  return `${expected === null ? '이관 당시 기준 없음' : `이관 당시 ${count(expected)}`} · 현재 ${count(observed)}`;
}

function count(value: number) { return `${value.toLocaleString('ko-KR')}개`; }

function AuditCounts<Status extends string>({ label, labels, counts, drill }: { label: string; labels: Record<Status, string>; counts: Record<Status, number>;
  drill?: { controls: string; select: (status: Status) => void } }) {
  return <dl className="migration-reconciliation-counts" aria-label={label}>
    {(Object.keys(labels) as Status[]).map(status => <div key={status}>
      <dt>{labels[status]}</dt>
      <dd>{drill && counts[status] > 0 ? <button type="button" className="migration-audit-drill migration-audit-count-drill"
        aria-label={`${labels[status]} ${count(counts[status])} 보기`} aria-controls={drill.controls}
        onClick={() => drill.select(status)}>{counts[status].toLocaleString('ko-KR')}</button> : counts[status].toLocaleString('ko-KR')}</dd>
    </div>)}
  </dl>;
}
