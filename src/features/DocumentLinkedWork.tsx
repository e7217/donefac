'use client';

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, Link2, RefreshCw, SquareChartGantt } from 'lucide-react';
import { isCalendarDate } from '../../shared/calendar';
import { buildDocumentLinkedWork } from '../../shared/document-linked-work';
import type { DocPage, FeatureProps, WorkspaceSnapshot } from '../../shared/types';
import type { OpenIssueForReview } from '../lib/issue-review';
import { DocumentDecisionRevision } from './DocumentBlocks';
import './document-linked-work.css';

type StatusFilter = 'all' | 'open' | 'closed';

interface Props {
  data: WorkspaceSnapshot;
  document: Pick<DocPage, 'id' | 'title' | 'projectId'>;
  openIssue: (id: string) => void;
  onOpenIssueForReview?: OpenIssueForReview;
  onOpenIssueSchedule?: (id: string) => boolean;
  refresh: () => Promise<void>;
  notify: FeatureProps['notify'];
  issueDrawerOpen?: boolean;
  children?: ReactNode;
}

export function DocumentLinkedWork({ data, document, openIssue, onOpenIssueForReview, onOpenIssueSchedule,
  refresh, notify, issueDrawerOpen = false, children }: Props) {
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const statusControl = useRef<HTMLSelectElement>(null);
  const refreshControl = useRef<HTMLButtonElement>(null);
  const issueOpener = useRef<HTMLButtonElement | null>(null);
  const mounted = useRef(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [evidenceOnly, setEvidenceOnly] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const { rows, counts } = useMemo(() => buildDocumentLinkedWork(data, document.id), [data, document.id]);
  const visible = rows.filter(({ closed, link }) =>
    (statusFilter === 'all' || closed === (statusFilter === 'closed')) && (!evidenceOnly || link?.documentSource));

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useLayoutEffect(() => {
    if (issueDrawerOpen || !issueOpener.current) return;
    const opener = issueOpener.current;
    issueOpener.current = null;
    (opener.isConnected ? opener : statusControl.current ?? refreshControl.current)?.focus({ preventScroll: true });
  }, [issueDrawerOpen]);

  async function reload() {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(false);
    try {
      await refresh();
      if (mounted.current) notify('연결된 업무를 새로고쳤습니다.');
    } catch {
      if (mounted.current) setRefreshError(true);
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }

  return <section className="document-linked-work" aria-labelledby={titleId}>
    <div className="docs-panel-heading document-linked-work-header">
      <h3 id={titleId} ref={heading} tabIndex={-1}>연결된 업무</h3>
      <div className="document-linked-work-actions">
        {children}
        <button type="button" className="btn btn-ghost" ref={refreshControl} disabled={refreshing}
          aria-label="연결된 업무 새로고침" onClick={() => void reload()}>
          <RefreshCw className={refreshing ? 'docs-spin' : undefined} size={14} aria-hidden="true" />
          {refreshing ? '새로고치는 중…' : '새로고침'}
        </button>
      </div>
    </div>
    {refreshError && <p className="docs-panel-error" role="alert">연결된 업무를 새로고치지 못했습니다.</p>}
    {(rows.length > 0 || statusFilter !== 'all' || evidenceOnly) && <div className="document-linked-work-filters">
      <select ref={statusControl} className="field" aria-label="연결된 업무 상태" value={statusFilter}
        onChange={event => setStatusFilter(event.currentTarget.value as StatusFilter)}>
        <option value="all">전체 {rows.length}개</option>
        <option value="open">미완료 {counts.open}개</option>
        <option value="closed">종료 {counts.closed}개</option>
      </select>
      <div className="document-linked-work-evidence-filter">
        <label><input type="checkbox" checked={evidenceOnly} onChange={event => setEvidenceOnly(event.currentTarget.checked)} />결정 근거가 있는 업무만</label>
        <span>결정 근거 {counts.evidence}개</span>
      </div>
    </div>}
    {visible.length ? <ul className="document-linked-work-list">{visible.map(({ issue, link, referenceCount, projectName, assigneeName, status, deadline }) => <li key={issue.id}>
      <button type="button" className="docs-linked-issue" data-issue-review-id={issue.id} onClick={event => {
        const opener = event.currentTarget;
        if (onOpenIssueForReview) {
          onOpenIssueForReview(issue.id, { issueIds: visible.map(row => row.issue.id), opener, fallback: heading.current, projectScope: null });
        } else {
          issueOpener.current = opener;
          openIssue(issue.id);
        }
      }}>
        <span className="docs-linked-issue-key">
          <span>
            {issue.key}
            {link?.kind === '후속 업무' && <span className="document-linked-work-kind">후속 업무</span>}
            {referenceCount > 0 && <span className="document-linked-work-kind document-linked-work-reference">본문 참조 {referenceCount}곳</span>}
          </span>
          <ChevronRight size={12} aria-hidden="true" />
        </span>
        <strong>{issue.title}</strong>
        <span className="docs-linked-issue-meta">
          {projectName && issue.projectId !== document.projectId && <span>{projectName}</span>}
          <span className="docs-linked-issue-status"><i style={{ backgroundColor: status.color }} aria-hidden="true" />{status.label}</span>
          <span>{assigneeName || '담당자 미지정'}</span>
          <span>{deadline ? <>{deadline.source === 'dueDate' ? '목표 마감일' : '계획 종료일'} <time dateTime={deadline.value}>{deadline.value}</time></> : '기한 없음'}</span>
        </span>
      </button>
      {onOpenIssueSchedule && <button className="btn btn-ghost document-linked-work-schedule" type="button"
        onClick={() => onOpenIssueSchedule(issue.id)}>
        <SquareChartGantt size={14} aria-hidden="true" />
        {isCalendarDate(issue.startDate) && isCalendarDate(issue.endDate) ? '간트에서 일정 보기' : '간트에서 날짜 입력'}
      </button>}
      {link?.documentSource && <section className="document-linked-work-evidence" aria-label={`${issue.key} 결정 근거`}>
        <h4>결정 근거</h4>
        <blockquote>{link.documentSource.text}</blockquote>
        <DocumentDecisionRevision key={link.documentSource.revisionId} data={data} documentId={document.id}
          revisionId={link.documentSource.revisionId} label={document.title} selection={link.documentSource} />
      </section>}
    </li>)}</ul> : <div className="docs-panel-empty" role="status">
      <Link2 size={21} aria-hidden="true" /><strong>{rows.length ? '조건에 맞는 업무가 없습니다.' : '연결된 업무가 없습니다.'}</strong>
    </div>}
  </section>;
}
