'use client';

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ClipboardCheck, Download, FileSearch, Loader2 } from 'lucide-react';
import type { SourceReconciliationAudit, SourceReconciliationAuditStatus, SourceReconciliationStatus } from '../../shared/types';
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

type Filter = 'all' | 'findings' | SourceReconciliationAuditStatus;
type AuditState = { kind: 'idle' | 'pending' | 'cancelled' } | { kind: 'complete'; result: SourceReconciliationAudit } | { kind: 'error'; message: string };

type AuditProps = {
  base: string;
  receiptVersion: number | null;
  canStart: boolean;
  recordLabels: Record<SourceReconciliationStatus, string>;
  onStale: () => void;
  detail: {
    openId: string | null;
    content: ReactNode;
    onToggle: (id: string, trigger: HTMLButtonElement) => void;
    onClose: () => void;
  };
};

export function MigrationReceiptAudit({ base, receiptVersion, canStart, recordLabels, onStale, detail }: AuditProps) {
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
        {report.attachments.length === 0 && <p>영수증에 첨부 원본이 없습니다.</p>}
      </>}
    </section>}
  </div>;
}

function AuditCounts<Status extends string>({ label, labels, counts }: { label: string; labels: Record<Status, string>; counts: Record<Status, number> }) {
  return <dl className="migration-reconciliation-counts" aria-label={label}>
    {(Object.keys(labels) as Status[]).map(status => <div key={status}><dt>{labels[status]}</dt><dd>{counts[status].toLocaleString('ko-KR')}</dd></div>)}
  </dl>;
}
