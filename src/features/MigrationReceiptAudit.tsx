'use client';

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ClipboardCheck, Download, FileSearch, Loader2 } from 'lucide-react';
import type { SourceReconciliationAudit, SourceReconciliationAuditStatus, SourceReconciliationIntegrity, SourceReconciliationIntegrityPackage, SourceReconciliationJiraStatusHistory, SourceReconciliationStatus } from '../../shared/types';
import { api, ApiError } from '../lib/api';
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
const jiraHistoryLabels = {
  sourceChanges: '보존 원본의 변경',
  projected: '현재 업무에 표시',
  duplicate: '중복 변경',
  excluded: '이관 제외',
  restricted: '표시 제한',
  unavailable: '표시 대상 확인 필요',
};

type Filter = 'all' | 'findings' | SourceReconciliationAuditStatus;
type AuditState = { kind: 'idle' | 'pending' | 'cancelled' } | { kind: 'complete'; result: SourceReconciliationAudit } | { kind: 'error'; message: string };

type AuditProps = {
  base: string;
  receiptVersion: number | null;
  canStart: boolean;
  recordLabels: Record<SourceReconciliationStatus, string>;
  onStale: () => void;
  onReviewJiraHistory: () => void;
  detail: {
    openId: string | null;
    content: ReactNode;
    onToggle: (id: string, trigger: HTMLButtonElement) => void;
    onClose: () => void;
  };
};

export function MigrationReceiptAudit({ base, receiptVersion, canStart, recordLabels, onStale, onReviewJiraHistory, detail }: AuditProps) {
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
        {report.jiraStatusHistory && <JiraStatusHistoryAudit history={report.jiraStatusHistory}
          integrity={report.integrity.status} onReviewHistory={onReviewJiraHistory} />}
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

function JiraStatusHistoryAudit({ history, integrity, onReviewHistory }: {
  history: SourceReconciliationJiraStatusHistory;
  integrity: SourceReconciliationIntegrity['status'];
  onReviewHistory: () => void;
}) {
  const { sourceChanges, projected, duplicate, excluded, restricted, unavailable, unresolvedTime, unresolvedAuthor } = history;
  const needsReview = integrity !== 'verified' || [restricted, unavailable, unresolvedTime, unresolvedAuthor].some(value => value > 0);
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
    {unavailable > 0 && <div>
      <p>표시되지 않은 변경의 보존 원본과 연결된 업무를 확인해 주세요.</p>
      <button type="button" className="btn btn-ghost" onClick={onReviewHistory}>원본 변경 이력 대조 열기</button>
    </div>}
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

function AuditCounts<Status extends string>({ label, labels, counts }: { label: string; labels: Record<Status, string>; counts: Record<Status, number> }) {
  return <dl className="migration-reconciliation-counts" aria-label={label}>
    {(Object.keys(labels) as Status[]).map(status => <div key={status}><dt>{labels[status]}</dt><dd>{counts[status].toLocaleString('ko-KR')}</dd></div>)}
  </dl>;
}
