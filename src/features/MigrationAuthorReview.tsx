'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { FileSearch, Loader2 } from 'lucide-react';
import {
  MIGRATION_AUTHOR_STATUSES, type LegacyPackageSummary, type MigrationAuthorKind, type MigrationAuthorPackageReview,
  type MigrationAuthorStatus, type SourceImport, type SourceReconciliationAuthorAudit, type SourceReconciliationAuthorFindingsPage,
  type User,
} from '../../shared/types';
import { api, ApiError } from '../lib/api';
import type { AuditDetail } from './MigrationReceiptAudit';

const PAGE_SIZE = 20;
const kindLabels: Record<MigrationAuthorKind, string> = {
  document: '문서', comment: '댓글', revision: '문서 버전', attachment: '첨부 버전', worklog: '작업 시간',
};
const statusLabels: Record<MigrationAuthorStatus, string> = {
  mapped: '팀원 매핑',
  'unmapped-fallback': '매핑 없음 · 이관 작업자로 기록',
  'missing-fallback': '원본 작성자 없음 · 이관 작업자로 기록',
  retained: '기존 작성자 유지',
  unavailable: '현재 대상 확인 불가',
  mismatch: '작성자 또는 대상 불일치',
};
type AuthorChoice = Pick<SourceReconciliationAuthorFindingsPage, 'packageId' | 'kind' | 'status'>;
type NamedPackage = { id: string; filename: string };
type AuthorDrill = { selected: AuthorChoice | null; panelId: string; onSelect: (choice: AuthorChoice, opener: HTMLButtonElement) => void };

function sameChoice(left: AuthorChoice | null, right: AuthorChoice) {
  return left?.packageId === right.packageId && left.kind === right.kind && left.status === right.status;
}

function AuthorCoverage({ groups, packages, drill }: {
  groups: readonly MigrationAuthorPackageReview[];
  packages: readonly NamedPackage[];
  drill?: AuthorDrill;
}) {
  const names = new Map(packages.map(({ id, filename }) => [id, filename]));
  return <ul className="migration-audit-integrity-packages" aria-label="원본 패키지별 작성자">
    {groups.filter(group => group.kinds.length > 0).map(({ packageId, kinds }) => <li key={packageId}>
      <strong>{names.get(packageId) ?? packageId}</strong>
      {kinds.map(({ kind, counts }) => <div className="migration-author-kind" key={kind}>
        <strong>{kindLabels[kind]}</strong>
        <dl className="migration-reconciliation-counts" aria-label={`${kindLabels[kind]} 작성자 건수`}>
          {MIGRATION_AUTHOR_STATUSES.filter(status => counts[status] > 0).map(status => {
            const value = counts[status].toLocaleString('ko-KR');
            const choice: AuthorChoice = { packageId, kind, status };
            const expanded = drill && sameChoice(drill.selected, choice);
            return <div key={status}>
              <dt>{statusLabels[status]}</dt>
              <dd>{drill ? <button type="button" className="migration-audit-drill migration-audit-count-drill"
                aria-label={`${kindLabels[kind]} ${statusLabels[status]} ${value}건 보기`}
                aria-controls={expanded ? drill.panelId : undefined} aria-expanded={expanded}
                onClick={event => drill.onSelect(choice, event.currentTarget)}>{value}</button> : value}</dd>
            </div>;
          })}
        </dl>
      </div>)}
    </li>)}
  </ul>;
}

export function MigrationAuthorPreview({ groups, packages }: {
  groups: readonly MigrationAuthorPackageReview[];
  packages: readonly LegacyPackageSummary[];
}) {
  return <section className="migration-audit-integrity" aria-label="작성자 매핑 미리보기">
    <div className="migration-audit-integrity-heading"><h4>작성자 매핑 미리보기</h4></div>
    <p>이관 작업자로 기록하는 항목에는 매핑이 없거나 원본 작성자 정보가 없습니다. 사용자 매핑을 바꾼 뒤 이관 미리보기를 다시 만들 수 있습니다.</p>
    <AuthorCoverage groups={groups} packages={packages} />
  </section>;
}

export function MigrationAuthorAudit({ report, base, receiptVersion, packages, users, detail, onRestart }: {
  report: SourceReconciliationAuthorAudit | null;
  base: string;
  receiptVersion: number;
  packages: readonly SourceImport['packages'][number][];
  users: readonly User[];
  detail: AuditDetail;
  onRestart: () => void;
}) {
  const [selected, setSelected] = useState<AuthorChoice | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();

  function close() {
    detail.onClose();
    setSelected(null);
    opener.current?.focus();
  }
  function select(choice: AuthorChoice, trigger: HTMLButtonElement) {
    if (sameChoice(selected, choice)) { close(); return; }
    detail.onClose();
    opener.current = trigger;
    setSelected(choice);
  }

  return <section className="migration-audit-integrity" aria-label="이관 작성자 검증">
    <div className="migration-audit-integrity-heading"><h5>이관 작성자 검증</h5></div>
    {!report ? <p>이 영수증에는 이관 당시 작성자 비교 정보가 없습니다.</p> : report.packages.some(pkg => pkg.kinds.length > 0) ? <>
      <p>이관 때 기록한 대상과 현재 작성자를 비교합니다. 건수를 선택하면 해당 원본을 확인할 수 있습니다.</p>
      <AuthorCoverage groups={report.packages} packages={packages.map(({ stagingId: id, filename }) => ({ id, filename }))}
        drill={{ selected, panelId, onSelect: select }} />
      {selected && <AuthorFindings key={`${selected.packageId}:${selected.kind}:${selected.status}`} id={panelId}
        base={base} receiptVersion={receiptVersion} fingerprint={report.fingerprint} choice={selected} users={users}
        detail={detail} onClose={close} onRestart={onRestart} />}
    </> : <p>작성자를 비교할 이관 항목이 없습니다.</p>}
  </section>;
}

type FindingsQuery = { offset: number };
type FindingsLoad = { query: FindingsQuery } & ({ data: SourceReconciliationAuthorFindingsPage } | { error: string; stale: boolean });

function AuthorFindings({ id, base, receiptVersion, fingerprint, choice, users, detail, onClose, onRestart }: {
  id: string;
  base: string;
  receiptVersion: number;
  fingerprint: string;
  choice: AuthorChoice;
  users: readonly User[];
  detail: AuditDetail;
  onClose: () => void;
  onRestart: () => void;
}) {
  const [query, setQuery] = useState<FindingsQuery>({ offset: 0 });
  const [loaded, setLoaded] = useState<FindingsLoad | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const response = loaded?.query === query ? loaded : null;
  const page = response && 'data' in response ? response.data : null;
  const failure = response && 'error' in response ? response : null;
  const { packageId, kind, status } = choice;
  const names = new Map(users.map(({ id, name }) => [id, name]));

  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    const abort = new AbortController();
    const params = new URLSearchParams({ expectedVersion: String(receiptVersion), packageId, kind, status,
      offset: String(query.offset), limit: String(PAGE_SIZE), expectedFingerprint: fingerprint });
    void api<SourceReconciliationAuthorFindingsPage>(`${base}/reconciliation/author-findings?${params}`, { signal: abort.signal, cache: 'no-store' })
      .then(data => { if (!abort.signal.aborted) setLoaded({ query, data }); })
      .catch(cause => {
        if (abort.signal.aborted) return;
        const stale = cause instanceof ApiError && cause.status === 409;
        const message = stale ? '작성자 대조 결과가 바뀌었습니다. 전체 이관 검증을 다시 실행해 주세요.'
          : cause instanceof Error ? cause.message : '작성자 목록을 불러오지 못했습니다.';
        setLoaded({ query, error: message, stale });
      });
    return () => abort.abort();
  }, [base, fingerprint, kind, packageId, query, receiptVersion, status]);

  function load(offset: number) {
    detail.onClose();
    heading.current?.focus();
    setQuery({ offset });
  }

  return <section id={id} className="migration-audit-findings" aria-labelledby={headingId}>
    <div className="migration-audit-heading">
      <h6 id={headingId} ref={heading} tabIndex={-1}>작성자 확인 목록</h6>
      <button type="button" className="btn btn-ghost" onClick={onClose}>작성자 목록 닫기</button>
    </div>
    <p>{kindLabels[kind]} · {statusLabels[status]}</p>
    {!response && <p role="status" className="migration-pending"><Loader2 size={15} className="spin" aria-hidden="true" />작성자 목록을 불러오는 중…</p>}
    {failure && <>
      <p role="alert" className="migration-error">{failure.error}</p>
      <button type="button" className="btn btn-ghost" onClick={() => failure.stale ? onRestart() : load(query.offset)}>
        {failure.stale ? '전체 이관 검증 다시 실행' : '작성자 목록 다시 조회'}
      </button>
    </>}
    {page && (page.rows.length ? <>
      <ul className="migration-reconciliation-list" aria-label="작성자 대조 원본 목록">
        {page.rows.map(row => <li key={row.sourceRecordId} className="migration-reconciliation-row">
          <div className="migration-reconciliation-source">
            <strong>원본 {kindLabels[row.kind]} {row.sourceId}</strong>
            <button type="button" className="btn btn-ghost" aria-label={`작성자 원본 ${row.sourceId} 열기`}
              aria-expanded={detail.openId === row.sourceRecordId} onClick={event => detail.onToggle(row.sourceRecordId, event.currentTarget)}>
              <FileSearch size={15} aria-hidden="true" />보존 원본 보기
            </button>
          </div>
          <div className="migration-reconciliation-target">
            <small>이관 시 작성자 <strong>{names.get(row.expectedAuthorId) ?? row.expectedAuthorId}</strong></small>
            <small>현재 작성자 <strong>{row.actualAuthorId ? names.get(row.actualAuthorId) ?? row.actualAuthorId : '확인 불가'}</strong></small>
          </div>
          {detail.openId === row.sourceRecordId && <div className="migration-reconciliation-record">{detail.content}</div>}
        </li>)}
      </ul>
      {page.total > page.limit && <div className="migration-pagination">
        <span role="status">{page.offset + 1}–{page.offset + page.rows.length} / {page.total.toLocaleString('ko-KR')}건</span>
        <button type="button" className="btn btn-ghost" aria-label="작성자 목록 이전 페이지" disabled={!page.offset}
          onClick={() => load(Math.max(0, page.offset - page.limit))}>이전</button>
        <button type="button" className="btn btn-ghost" aria-label="작성자 목록 다음 페이지" disabled={page.offset + page.limit >= page.total}
          onClick={() => load(page.offset + page.limit)}>다음</button>
      </div>}
    </> : <p role="status">선택한 상태의 작성자 원본이 없습니다.</p>)}
  </section>;
}
