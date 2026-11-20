'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  DELIVERY_BLOCKER_REASONS, PRIORITY, type DeliveryBlockerIssue, type DeliveryBlockerReason,
  type DeliveryBlockerReport, type DeliveryBlockerRow, type FeatureProps,
} from '../../shared/types';
import { SCHEDULE_DATE_LABELS } from '../../shared/schedule-dependencies';
import { api, ApiError } from '../lib/api';
import { dependencyLabel } from './schedule-utils';
import './delivery-blockers-report.css';

type Scope = { savedViewId: string; reason: DeliveryBlockerReason | '' };
type Props = Pick<FeatureProps, 'data' | 'projectId' | 'actorId' | 'notify' | 'openIssue' | 'refresh'>;
const ALL: Scope = { savedViewId: '', reason: '' };
const REASON_LABELS: Record<DeliveryBlockerReason, string> = {
  issue_block: '수동 차단',
  schedule_conflict: '간트 일정 충돌',
  gitlab: 'GitLab 조치',
};
const numberLabel = (value: number) => value.toLocaleString('ko-KR');
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : '진행 차단 보고서를 불러오지 못했습니다.';

export function DeliveryBlockersReport({ data, projectId, actorId, notify, openIssue, refresh }: Props) {
  const [scope, setScope] = useState(ALL);
  const [page, setPage] = useState<DeliveryBlockerReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [openingIssue, setOpeningIssue] = useState<string | null>(null);
  const reportRequest = useRef<AbortController | null>(null);
  const issueRequest = useRef<symbol | null>(null);
  const resultsHeading = useRef<HTMLHeadingElement>(null);
  const focusResults = useRef(false);
  const views = (data.savedViews ?? []).filter(view => view.projectId === projectId)
    .sort((left, right) => left.name.localeCompare(right.name, 'ko'));
  const unavailableView = scope.savedViewId && !views.some(view => view.id === scope.savedViewId);

  const load = useCallback(async (next: Scope, offset = 0, revision?: string) => {
    reportRequest.current?.abort();
    const controller = new AbortController();
    reportRequest.current = controller;
    issueRequest.current = null;
    focusResults.current = false;
    setOpeningIssue(null);
    setLoading(true);
    setError('');
    setNotice('');
    function requestPage(position?: { offset: number; revision: string }) {
      const params = new URLSearchParams();
      if (next.savedViewId) params.set('savedViewId', next.savedViewId);
      if (next.reason) params.set('reason', next.reason);
      if (position?.offset) params.set('offset', String(position.offset));
      if (position) params.set('revision', position.revision);
      const suffix = params.size ? `?${params}` : '';
      return api<DeliveryBlockerReport>(`/projects/${encodeURIComponent(projectId)}/delivery-blockers${suffix}`, {
        cache: 'no-store', signal: controller.signal, headers: { 'X-Actor-Id': actorId },
      });
    }
    try {
      let result: DeliveryBlockerReport;
      try {
        result = await requestPage(revision ? { offset, revision } : undefined);
      } catch (cause) {
        if (controller.signal.aborted || !revision || !(cause instanceof ApiError) || cause.status !== 409) throw cause;
        setPage(null);
        result = await requestPage();
        if (!controller.signal.aborted) setNotice('업무 변경을 반영해 첫 페이지를 다시 불러왔습니다.');
      }
      if (!controller.signal.aborted) {
        focusResults.current = Boolean(revision);
        setPage(result);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) {
        reportRequest.current = null;
        setLoading(false);
      }
    }
  }, [actorId, projectId]);

  useEffect(() => {
    const timer = setTimeout(() => void load(ALL), 0);
    return () => {
      clearTimeout(timer);
      reportRequest.current?.abort();
      issueRequest.current = null;
    };
  }, [load]);

  useEffect(() => {
    if (!page || !focusResults.current) return;
    focusResults.current = false;
    resultsHeading.current?.focus();
  }, [page]);

  function changeScope(next: Scope) {
    setScope(next);
    setPage(null);
    void load(next);
  }

  function changePage(offset: number) {
    if (!page || loading || offset < 0 || offset >= page.total) return;
    void load(scope, offset, page.revision);
  }

  async function open(issue: DeliveryBlockerIssue) {
    if (issueRequest.current || reportRequest.current) return;
    const cached = data.issues.find(value => value.id === issue.id);
    if (cached?.projectId === issue.projectId && cached.version === issue.version) {
      openIssue(issue.id);
      return;
    }
    const token = Symbol();
    issueRequest.current = token;
    setOpeningIssue(issue.id);
    try {
      await refresh();
      if (issueRequest.current === token) openIssue(issue.id);
    } catch (cause) {
      if (issueRequest.current === token) notify(errorMessage(cause), 'error');
    } finally {
      if (issueRequest.current === token) {
        issueRequest.current = null;
        setOpeningIssue(null);
      }
    }
  }

  return <div className="delivery-blockers-report">
    <header className="card delivery-blockers-query">
      <h2>진행 차단</h2>
      <p>다른 업무에 막혔거나 저장된 간트 일정이 충돌하거나 GitLab 조치가 필요한 업무를 확인하세요.</p>
      <div className="delivery-blockers-controls">
        <label>공유 보기
          <select className="field" aria-label="진행 차단 공유 보기" value={scope.savedViewId}
            onChange={event => changeScope({ ...scope, savedViewId: event.target.value })}>
            <option value="">프로젝트 전체</option>
            {unavailableView && <option value={scope.savedViewId}>{page?.savedView?.name ?? '현재 공유 보기 없음'}</option>}
            {views.map(view => <option key={view.id} value={view.id}>{view.name}</option>)}
          </select>
        </label>
        <label>차단 원인
          <select className="field" aria-label="진행 차단 원인" value={scope.reason}
            onChange={event => changeScope({ ...scope, reason: event.target.value as Scope['reason'] })}>
            <option value="">전체 원인</option>
            {DELIVERY_BLOCKER_REASONS.map(reason => <option key={reason} value={reason}>{REASON_LABELS[reason]}</option>)}
          </select>
        </label>
        <button type="button" className="btn" disabled={loading} onClick={() => void load(scope)}>
          <RefreshCw size={15} aria-hidden="true" />진행 차단 새로고침
        </button>
      </div>
    </header>

    {error && <p className="reports-error" role="alert">{error}</p>}
    {notice && <p className="delivery-blockers-notice" role="status">{notice}</p>}
    {loading && <p className="delivery-blockers-notice" role="status">진행 차단을 불러오는 중입니다.</p>}
    {openingIssue && <p className="delivery-blockers-notice" role="status">업무를 불러오는 중입니다.</p>}
    {page && <div aria-busy={loading}>
      <dl className="delivery-blockers-summary" aria-label="진행 차단 요약">
        <div className="card"><dt>차단된 업무</dt><dd>{numberLabel(page.counts.affected)}개</dd></div>
        {DELIVERY_BLOCKER_REASONS.map(reason => <div className="card" key={reason}>
          <dt>{REASON_LABELS[reason]}</dt><dd>{numberLabel(page.counts.reasons[reason])}개</dd>
        </div>)}
      </dl>
      <p className="delivery-blockers-scope">
        <strong>{page.savedView?.name ?? '프로젝트 전체'}</strong> · 열린 업무 {numberLabel(page.counts.open)}개 기준 · 조회 <time dateTime={page.generatedAt}>{new Date(page.generatedAt).toLocaleString('ko-KR')}</time>
      </p>
      <section className="delivery-blockers-results" aria-labelledby="delivery-blockers-results-heading">
        <header>
          <h3 id="delivery-blockers-results-heading" ref={resultsHeading} tabIndex={-1}>차단된 업무</h3>
          <span>{page.reason ? REASON_LABELS[page.reason] : '전체 원인'} · {numberLabel(page.total)}개</span>
        </header>
        {page.items.length > 0 ? <ol className="delivery-blockers-list" role="list" aria-label="차단된 업무 목록">
          {page.items.map(row => <li key={row.issue.id}><BlockerCard row={row} linkBusy={loading || Boolean(openingIssue)} open={open} /></li>)}
        </ol> : <p className="card delivery-blockers-empty">이 조건에 해당하는 차단 업무가 없습니다.</p>}
        {page.total > page.limit && <nav className="delivery-blockers-pagination" aria-label="차단된 업무 페이지">
          <span role="status">{numberLabel(page.offset + 1)}–{numberLabel(page.offset + page.items.length)} / {numberLabel(page.total)}개</span>
          <button type="button" className="btn" disabled={loading || !page.offset}
            onClick={() => changePage(Math.max(0, page.offset - page.limit))}>이전 페이지</button>
          <button type="button" className="btn" disabled={loading || page.offset + page.limit >= page.total}
            onClick={() => changePage(page.offset + page.limit)}>다음 페이지</button>
        </nav>}
      </section>
    </div>}
  </div>;
}

type IssueAction = { linkBusy: boolean; open: (issue: DeliveryBlockerIssue) => void };

function BlockerIssueButton({ issue, linkBusy, open }: IssueAction & { issue: DeliveryBlockerIssue }) {
  return <button type="button" className="delivery-blockers-issue" aria-label={`${issue.key} ${issue.title} 업무 열기`}
    aria-disabled={linkBusy} onClick={() => { if (!linkBusy) open(issue); }}>
    <span className="issue-key">{issue.key}</span><strong>{issue.title}</strong>
  </button>;
}

function BlockerCard({ row, ...action }: IssueAction & { row: DeliveryBlockerRow }) {
  const { issue, deadline, blockers, scheduleConflicts, gitlab } = row;
  return <article className="card delivery-blockers-card" aria-label={`차단된 업무 ${issue.key}`}>
    <h4><BlockerIssueButton issue={issue} {...action} /></h4>
    <dl className="delivery-blockers-properties">
      <div><dt>상태</dt><dd>{issue.statusLabel}</dd></div>
      <div><dt>담당자</dt><dd>{issue.assigneeName ?? '미지정'}</dd></div>
      <div><dt>우선순위</dt><dd>{PRIORITY[row.priority]}</dd></div>
      <div><dt>{deadline?.source === 'endDate' ? '종료일' : '목표 마감일'}</dt>
        <dd>{deadline ? <time dateTime={deadline.value}>{deadline.value}</time> : '미정'}</dd>
      </div>
    </dl>
    <div className="delivery-blockers-causes">
      {blockers.total > 0 && <section>
        <h5>{REASON_LABELS.issue_block} <span>{numberLabel(blockers.total)}건</span></h5>
        <ul>{blockers.items.map(source => <li key={source.id}><BlockerIssueButton issue={source} {...action} /></li>)}</ul>
        {blockers.total > blockers.items.length && <p>앞 {numberLabel(blockers.items.length)}건을 표시합니다.</p>}
      </section>}
      {scheduleConflicts.total > 0 && <section>
        <h5>{REASON_LABELS.schedule_conflict} <span>{numberLabel(scheduleConflicts.total)}건</span></h5>
        <ul>{scheduleConflicts.items.map(conflict => <li key={`${conflict.predecessor.id}:${conflict.type}:${conflict.lagDays}`}>
          <BlockerIssueButton issue={conflict.predecessor} {...action} />
          <p>{dependencyLabel(conflict)} · {SCHEDULE_DATE_LABELS[conflict.endpoint]} <time dateTime={conflict.scheduledDate}>{conflict.scheduledDate}</time> · <time dateTime={conflict.requiredDate}>{conflict.requiredDate}</time>부터 가능</p>
        </li>)}</ul>
        {scheduleConflicts.total > scheduleConflicts.items.length && <p>앞 {numberLabel(scheduleConflicts.items.length)}건을 표시합니다.</p>}
      </section>}
      {Boolean(gitlab.blockedMergeRequests || gitlab.failedPipelines) && <section>
        <h5>{REASON_LABELS.gitlab}</h5>
        <ul>
          {gitlab.blockedMergeRequests > 0 && <li>병합 확인이 필요한 MR {numberLabel(gitlab.blockedMergeRequests)}건</li>}
          {gitlab.failedPipelines > 0 && <li>실패한 파이프라인 {numberLabel(gitlab.failedPipelines)}건</li>}
        </ul>
      </section>}
    </div>
  </article>;
}
