'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { ArrowUpRight, Loader2 } from 'lucide-react';
import { isRelationId } from '../../shared/issue-relations';
import type {
  SourceReconciliationResourceLinkFinding, SourceReconciliationResourceLinkFindingsPage,
  SourceReconciliationResourceLinkProjection, SourceReconciliationResourceLinkRow, SourceReconciliationResourceLinkStatus,
} from '../../shared/types';
import { api, ApiError } from '../lib/api';

const PAGE_SIZE = 20;
const labels: Record<SourceReconciliationResourceLinkStatus, string> = {
  linked: '현재 연결',
  trashed: '휴지통 보관',
  missing: '연결 누락',
  mismatch: '이관 당시와 불일치',
  unavailable: '연결 확인 불가',
};
const findingClass: Record<SourceReconciliationResourceLinkFinding, string> = {
  missing: 'is-missing',
  mismatch: 'is-mismatch',
  unavailable: 'is-unbound',
};
const staleMessage = '업무·문서 연결 검증 결과가 바뀌었습니다. 전체 이관 검증을 다시 실행해 주세요.';
const format = (value: number) => value.toLocaleString('ko-KR');

type Navigation = {
  openIssue?: (id: string) => void;
  openDocument?: (id: string) => void;
  canOpenEndpoint?: (kind: 'issue' | 'document', id: string) => boolean;
};
type AuditProps = Navigation & {
  projection: SourceReconciliationResourceLinkProjection;
  base: string;
  importId: string;
  receiptVersion: number;
  onRestart: () => void;
};

function validFindingRow(row: SourceReconciliationResourceLinkRow) {
  return row && isRelationId(row.id) && isRelationId(row.issueId) && isRelationId(row.documentId) &&
    (row.issue === null || (row.issue?.id === row.issueId && typeof row.issue.key === 'string' && typeof row.issue.title === 'string')) &&
    (row.document === null || (row.document?.id === row.documentId && typeof row.document.title === 'string'));
}

export function MigrationResourceLinkAudit({ projection, base, importId, receiptVersion, onRestart, openIssue, openDocument, canOpenEndpoint }: AuditProps) {
  const [selected, setSelected] = useState<SourceReconciliationResourceLinkFinding | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const findingsId = useId();
  const { expected, counts, sha256 } = projection;
  const tracked = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const legacyGap = expected === null ? 0 : expected - tracked;
  const failed = counts.missing > 0 || counts.mismatch > 0 || legacyGap < 0;
  const needsReview = counts.trashed > 0 || counts.unavailable > 0;
  const status = failed ? { label: '검증 실패', className: 'is-mismatch' }
    : legacyGap > 0 ? { label: '건수만 비교', className: 'is-unbound' }
      : expected === null || needsReview ? { label: '확인 필요', className: 'is-unbound' }
        : { label: '일치', className: 'is-verified' };
  if (expected === 0 && tracked === 0) return null;

  function close() {
    setSelected(null);
    opener.current?.focus();
  }

  return <section className="migration-audit-integrity" aria-label="업무·문서 연결 검증">
    <div className="migration-audit-integrity-heading">
      <h5>업무·문서 연결 검증</h5>
      <span className={`migration-audit-status ${status.className}`}>{status.label}</span>
    </div>
    <dl className="migration-audit-integrity-counts" aria-label="업무·문서 연결 검증 건수">
      <div><dt>이관 당시</dt><dd>{expected === null ? '건수 기준 없음' : `${format(expected)}개`}</dd></div>
      <div><dt>연결 ID로 검증</dt><dd>{format(tracked)}개</dd></div>
    </dl>
    {legacyGap > 0 && <p>이관 당시 집계 중 {format(legacyGap)}개는 영수증에 연결 ID가 없어 건수만 남아 있습니다.</p>}
    {legacyGap < 0 && <p role="alert" className="migration-error">검증한 연결이 이관 당시 집계보다 {format(-legacyGap)}개 많습니다.</p>}
    <dl className="migration-reconciliation-counts" aria-label="업무·문서 연결 상태별 건수">
      {(Object.keys(labels) as SourceReconciliationResourceLinkStatus[]).map(status => {
        const count = counts[status];
        const finding = status === 'linked' || status === 'trashed' ? null : status;
        return <div key={status}>
          <dt>{labels[status]}</dt>
          <dd>{finding && count > 0 ? <button type="button"
            className={`migration-audit-drill migration-audit-count-drill migration-audit-status ${findingClass[finding]}`}
            aria-label={`${labels[status]} ${format(count)}개 보기`} aria-expanded={selected === finding}
            aria-controls={selected === finding ? findingsId : undefined} onClick={event => {
              if (selected === finding) { close(); return; }
              opener.current = event.currentTarget;
              setSelected(finding);
            }}>{format(count)}</button> : format(count)}</dd>
        </div>;
      })}
    </dl>
    {selected && <ResourceLinkFindings key={selected} id={findingsId} base={base} importId={importId}
      receiptVersion={receiptVersion} sha256={sha256} count={counts[selected]} finding={selected}
      openIssue={openIssue} openDocument={openDocument} canOpenEndpoint={canOpenEndpoint} onClose={close} onRestart={onRestart} />}
  </section>;
}

type Query = { offset: number };
type Load = { query: Query } & ({ data: SourceReconciliationResourceLinkFindingsPage } | { error: string; stale: boolean });

function ResourceLinkFindings({ id, base, importId, receiptVersion, sha256, count, finding, openIssue, openDocument, canOpenEndpoint, onClose, onRestart }:
  Omit<AuditProps, 'projection'> & { id: string; sha256: string; count: number; finding: SourceReconciliationResourceLinkFinding; onClose: () => void }) {
  const [query, setQuery] = useState<Query>({ offset: 0 });
  const [loaded, setLoaded] = useState<Load | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const response = loaded?.query === query ? loaded : null;
  const page = response && 'data' in response ? response.data : null;
  const failure = response && 'error' in response ? response : null;

  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    const abort = new AbortController();
    const params = new URLSearchParams({
      expectedVersion: String(receiptVersion), expectedSha256: sha256, finding, offset: String(query.offset), limit: String(PAGE_SIZE),
    });
    void api<SourceReconciliationResourceLinkFindingsPage>(`${base}/reconciliation/resource-link-findings?${params}`,
      { signal: abort.signal, cache: 'no-store' })
      .then(data => {
        if (abort.signal.aborted) return;
        if (!data || data.importId !== importId || data.receiptVersion !== receiptVersion || data.finding !== finding ||
            data.sha256 !== sha256 || data.total !== count || data.offset !== query.offset || data.limit !== PAGE_SIZE ||
            !Array.isArray(data.rows) || data.rows.length !== Math.min(PAGE_SIZE, count - query.offset) ||
            !data.rows.every(validFindingRow) || new Set(data.rows.map(row => row.id)).size !== data.rows.length) {
          setLoaded({ query, error: staleMessage, stale: true });
          return;
        }
        setLoaded({ query, data });
      })
      .catch(cause => {
        if (abort.signal.aborted) return;
        const stale = cause instanceof ApiError && cause.status === 409;
        const error = stale ? staleMessage : cause instanceof Error ? cause.message : '업무·문서 연결 목록을 불러오지 못했습니다.';
        setLoaded({ query, error, stale });
      });
    return () => abort.abort();
  }, [base, count, finding, importId, query, receiptVersion, sha256]);

  function load(offset: number) {
    heading.current?.focus();
    setQuery({ offset });
  }

  return <section id={id} className="migration-audit-findings" aria-labelledby={headingId}>
    <div className="migration-audit-heading">
      <h6 id={headingId} ref={heading} tabIndex={-1}>확인할 업무·문서 연결</h6>
      <button type="button" className="btn btn-ghost" onClick={onClose}>연결 목록 닫기</button>
    </div>
    <p>{labels[finding]} {format(count)}개</p>
    {!response && <p role="status" className="migration-pending"><Loader2 size={15} className="spin" aria-hidden="true" />업무·문서 연결 목록을 불러오는 중…</p>}
    {failure && <>
      <p role="alert" className="migration-error">{failure.error}</p>
      <button type="button" className="btn btn-ghost" onClick={() => failure.stale ? onRestart() : load(query.offset)}>
        {failure.stale ? '전체 이관 검증 다시 실행' : '업무·문서 연결 목록 다시 조회'}
      </button>
    </>}
    {page && <>
      <ul className="migration-reconciliation-list" aria-label="업무·문서 연결 목록">
        {page.rows.map(row => <li key={row.id} className="migration-reconciliation-row">
          <small className="migration-reconciliation-record">연결 ID <code>{row.id}</code></small>
          <div className="migration-reconciliation-source">
            <strong>{row.issue ? `${row.issue.key} · ${row.issue.title}` : '현재 업무 확인 불가'}</strong>
            <small>업무 ID <code>{row.issueId}</code></small>
            {row.issue && openIssue && canOpenEndpoint?.('issue', row.issueId) && <button type="button" className="btn btn-ghost"
              aria-label={`현재 업무 열기 ${row.issue.key} ${row.issue.title}`} onClick={() => openIssue(row.issueId)}>
              <ArrowUpRight size={15} aria-hidden="true" />현재 업무 열기
            </button>}
          </div>
          <div className="migration-reconciliation-target">
            <strong>{row.document?.title ?? '현재 문서 확인 불가'}</strong>
            <small>문서 ID <code>{row.documentId}</code></small>
            {row.document && openDocument && canOpenEndpoint?.('document', row.documentId) && <button type="button" className="btn btn-ghost"
              aria-label={`현재 문서 열기 ${row.document.title}`} onClick={() => openDocument(row.documentId)}>
              <ArrowUpRight size={15} aria-hidden="true" />현재 문서 열기
            </button>}
          </div>
        </li>)}
      </ul>
      {page.total > page.limit && <div className="migration-pagination">
        <span role="status">{page.offset + 1}–{page.offset + page.rows.length} / {format(page.total)}개</span>
        <button type="button" className="btn btn-ghost" aria-label="업무·문서 연결 이전 페이지" disabled={!page.offset}
          onClick={() => load(Math.max(0, page.offset - page.limit))}>이전</button>
        <button type="button" className="btn btn-ghost" aria-label="업무·문서 연결 다음 페이지" disabled={page.offset + page.limit >= page.total}
          onClick={() => load(page.offset + page.limit)}>다음</button>
      </div>}
    </>}
  </section>;
}
