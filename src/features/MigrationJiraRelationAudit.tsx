'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { FileSearch, Loader2 } from 'lucide-react';
import type {
  SourceReconciliationJiraRelationFinding, SourceReconciliationJiraRelationFindingsPage,
  SourceReconciliationJiraRelationProjection, SourceReconciliationJiraRelationStatus,
} from '../../shared/types';
import { api, ApiError } from '../lib/api';
import type { AuditDetail } from './MigrationReceiptAudit';

const PAGE_SIZE = 20;
const labels: Record<SourceReconciliationJiraRelationStatus, string> = {
  linked: '현재 연결',
  trashed: '휴지통 보관',
  missing: '관계 누락',
  mismatch: '원본과 불일치',
  unavailable: '연결 확인 불가',
};
const findingClass: Record<SourceReconciliationJiraRelationFinding, string> = {
  missing: 'is-missing',
  mismatch: 'is-mismatch',
  unavailable: 'is-unbound',
};

type AuditProps = {
  projection: SourceReconciliationJiraRelationProjection;
  base: string;
  importId: string;
  receiptVersion: number;
  detail: AuditDetail;
  onRestart: () => void;
};

const format = (value: number) => value.toLocaleString('ko-KR');
const staleMessage = 'Jira 관계 검증 결과가 바뀌었습니다. 전체 이관 검증을 다시 실행해 주세요.';

export function MigrationJiraRelationAudit({ projection, base, importId, receiptVersion, detail, onRestart }: AuditProps) {
  const [selected, setSelected] = useState<SourceReconciliationJiraRelationFinding | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const findingsId = useId();
  const { expected, counts, sha256 } = projection;
  const tracked = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const legacyGap = expected === null ? 0 : expected - tracked;
  const failed = counts.missing > 0 || counts.mismatch > 0 || legacyGap < 0;
  const review = expected === null || legacyGap > 0 || counts.trashed > 0 || counts.unavailable > 0;
  const status = failed ? { label: '검증 실패', className: 'is-mismatch' }
    : review ? { label: '확인 필요', className: 'is-unbound' }
      : { label: '일치', className: 'is-verified' };

  function close() {
    detail.onClose();
    setSelected(null);
    opener.current?.focus();
  }

  function select(finding: SourceReconciliationJiraRelationFinding, trigger: HTMLButtonElement) {
    if (selected === finding) { close(); return; }
    detail.onClose();
    opener.current = trigger;
    setSelected(finding);
  }

  return <section className="migration-audit-integrity" aria-label="Jira 업무 관계 검증">
    <div className="migration-audit-integrity-heading">
      <h5>Jira 업무 관계 검증</h5>
      <span className={`migration-audit-status ${status.className}`}>{status.label}</span>
    </div>
    <dl className="migration-audit-integrity-counts" aria-label="이관 당시와 현재 관계 건수">
      <div><dt>이관 당시</dt><dd>{expected === null ? '건수 기준 없음' : `${format(expected)}개`}</dd></div>
      <div><dt>현재 추적한 관계</dt><dd>{format(tracked)}개</dd></div>
    </dl>
    {legacyGap > 0 && <p>이관 당시 집계 중 {format(legacyGap)}개 관계는 보존 원본에서 연결 근거를 확인할 수 없습니다.</p>}
    {legacyGap < 0 && <p role="alert" className="migration-error">현재 추적한 관계가 이관 당시 집계보다 {format(-legacyGap)}개 많습니다.</p>}
    <dl className="migration-reconciliation-counts" aria-label="Jira 업무 관계 상태별 건수">
      {(Object.keys(labels) as SourceReconciliationJiraRelationStatus[]).map(status => {
        const count = counts[status];
        const finding = status === 'linked' || status === 'trashed' ? null : status;
        return <div key={status}>
          <dt>{labels[status]}</dt>
          <dd>{finding && count > 0 ? <button type="button"
            className={`migration-audit-drill migration-audit-count-drill migration-audit-status ${findingClass[finding]}`}
            aria-label={`${labels[status]} ${format(count)}개 보기`} aria-expanded={selected === finding}
            aria-controls={selected === finding ? findingsId : undefined} onClick={event => select(finding, event.currentTarget)}>
            {format(count)}
          </button> : format(count)}</dd>
        </div>;
      })}
    </dl>
    {selected && <RelationFindings key={selected} id={findingsId} base={base} importId={importId}
      receiptVersion={receiptVersion} sha256={sha256} count={counts[selected]} finding={selected}
      detail={detail} onClose={close} onRestart={onRestart} />}
  </section>;
}

type Query = { offset: number };
type Load = { query: Query } & ({ data: SourceReconciliationJiraRelationFindingsPage } | { error: string; stale: boolean });

function RelationFindings({ id, base, importId, receiptVersion, sha256, count, finding, detail, onClose, onRestart }:
  Omit<AuditProps, 'projection'> & { id: string; sha256: string; count: number; finding: SourceReconciliationJiraRelationFinding; onClose: () => void }) {
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
    void api<SourceReconciliationJiraRelationFindingsPage>(`${base}/reconciliation/jira-relation-findings?${params}`, { signal: abort.signal, cache: 'no-store' })
      .then(data => {
        if (abort.signal.aborted) return;
        if (data.importId !== importId || data.receiptVersion !== receiptVersion || data.finding !== finding || data.sha256 !== sha256 ||
            data.total !== count || data.offset !== query.offset || data.limit !== PAGE_SIZE ||
            !Array.isArray(data.rows) || data.rows.length !== Math.min(PAGE_SIZE, count - query.offset)) {
          setLoaded({ query, error: staleMessage, stale: true });
          return;
        }
        setLoaded({ query, data });
      })
      .catch(cause => {
        if (abort.signal.aborted) return;
        const stale = cause instanceof ApiError && cause.status === 409;
        const error = stale ? staleMessage : cause instanceof Error ? cause.message : 'Jira 관계 목록을 불러오지 못했습니다.';
        setLoaded({ query, error, stale });
      });
    return () => abort.abort();
  }, [base, count, finding, importId, query, receiptVersion, sha256]);

  function load(offset: number) {
    detail.onClose();
    heading.current?.focus();
    setQuery({ offset });
  }

  return <section id={id} className="migration-audit-findings" aria-labelledby={headingId}>
    <div className="migration-audit-heading">
      <h6 id={headingId} ref={heading} tabIndex={-1}>확인할 Jira 관계</h6>
      <button type="button" className="btn btn-ghost" onClick={onClose}>관계 목록 닫기</button>
    </div>
    <p>{labels[finding]} {format(count)}개</p>
    {!response && <p role="status" className="migration-pending"><Loader2 size={15} className="spin" aria-hidden="true" />Jira 관계 목록을 불러오는 중…</p>}
    {failure && <>
      <p role="alert" className="migration-error">{failure.error}</p>
      <button type="button" className="btn btn-ghost" onClick={() => failure.stale ? onRestart() : load(query.offset)}>
        {failure.stale ? '전체 이관 검증 다시 실행' : 'Jira 관계 목록 다시 조회'}
      </button>
    </>}
    {page && <>
      <ul className="migration-reconciliation-list" aria-label="Jira 관계 원본 목록">
        {page.rows.map(row => <li key={row.sourceRecordId} className="migration-reconciliation-row">
          <div className="migration-reconciliation-source">
            <small>Jira · {row.sourceInstance}</small>
            <strong>원본 관계 {row.sourceId}</strong>
            <button type="button" className="btn btn-ghost" aria-label={`Jira 관계 원본 ${row.sourceInstance} / ${row.sourceId} 열기`}
              aria-expanded={detail.openId === row.sourceRecordId} onClick={event => detail.onToggle(row.sourceRecordId, event.currentTarget)}>
              <FileSearch size={15} aria-hidden="true" />보존 원본 보기
            </button>
          </div>
          {detail.openId === row.sourceRecordId && <div className="migration-reconciliation-record">{detail.content}</div>}
        </li>)}
      </ul>
      {page.total > page.limit && <div className="migration-pagination">
        <span role="status">{page.offset + 1}–{page.offset + page.rows.length} / {format(page.total)}개</span>
        <button type="button" className="btn btn-ghost" aria-label="Jira 관계 이전 페이지" disabled={!page.offset}
          onClick={() => load(Math.max(0, page.offset - page.limit))}>이전</button>
        <button type="button" className="btn btn-ghost" aria-label="Jira 관계 다음 페이지" disabled={page.offset + page.limit >= page.total}
          onClick={() => load(page.offset + page.limit)}>다음</button>
      </div>}
    </>}
  </section>;
}
