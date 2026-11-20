'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, ExternalLink, RefreshCw, Workflow } from 'lucide-react';
import { AUTOMATION_TRIGGER_LABELS } from '../../shared/automation';
import type { AutomationRun, FeatureProps, GitlabLink, IssueAutomationRunPage, User } from '../../shared/types';
import { api } from '../lib/api';
import { gitlabActivityUrl } from './GitlabActivity';
import './issue-automation-history.css';

const outcomes: Record<AutomationRun['outcome'], string> = {
  changed: '변경됨', no_op: '변경 없음', blocked: '차단', ignored: '건너뜀',
};

type Props = Pick<FeatureProps, 'refresh'> & {
  issueId: string;
  issueVersion: number;
  links: readonly GitlabLink[];
  users: readonly User[];
  canPrepareStatus: (run: AutomationRun) => boolean;
  onPrepareStatus: (run: AutomationRun) => void;
};

function sourceUrl(run: AutomationRun, links: readonly GitlabLink[]): URL | null {
  const context = run.context;
  if (!context || !/^[1-9]\d*$/u.test(context.objectId)) return null;
  const source = /^gitlab:([a-f0-9]{12}):([1-9]\d*):(merge_request|pipeline):[a-f0-9]{64}$/u.exec(run.eventId);
  if (!source || source[2] !== String(context.gitlabProjectId) || source[3] !== context.objectKind) return null;
  const linkId = `gitlab:${source[1]}:${context.gitlabProjectId}:${context.objectKind}:${context.objectId}:${run.issueId}`;
  const link = links.find(value => value.id === linkId && value.issueId === run.issueId &&
    value.projectId === context.gitlabProjectId && value.kind === context.objectKind);
  if (!link) return null;
  const base = gitlabActivityUrl(context.gitlabBaseUrl, context.objectKind);
  const url = gitlabActivityUrl(link.webUrl, link.kind);
  if (!url || !base || url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname.replace(/\/+$/u, '')}/`)) return null;
  const suffix = link.kind === 'merge_request' ? `/-/merge_requests/${link.iid}` : `/-/pipelines/${context.objectId}`;
  return url.pathname.endsWith(suffix) ? url : null;
}

export function IssueAutomationHistory({ issueId, issueVersion, links, users, refresh, canPrepareStatus, onPrepareStatus }: Props) {
  const [history, setHistory] = useState<IssueAutomationRunPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const path = `/issues/${encodeURIComponent(issueId)}/automation-runs`;

  const load = useCallback(async ({ before, refreshIssue = false }: { before?: string; refreshIssue?: boolean } = {}) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError('');
    try {
      const [page] = await Promise.all([
        api<IssueAutomationRunPage>(`${path}${before ? `?before=${encodeURIComponent(before)}` : ''}`, {
          signal: controller.signal, cache: 'no-store',
        }),
        refreshIssue ? refresh() : null,
      ]);
      if (controller.signal.aborted) return;
      setHistory(previous => before && previous ? { ...page, items: [...previous.items, ...page.items] } : page);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '자동화 기록을 불러오지 못했습니다.');
    } finally {
      if (!controller.signal.aborted) {
        request.current = null;
        setLoading(false);
      }
    }
  }, [path, refresh]);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(initial);
      request.current?.abort();
    };
  }, [issueVersion, load]);

  const current = history?.issueVersion === issueVersion && !loading && !error;
  return <section className="issue-related-section issue-automation-history" aria-label="GitLab 상태 자동화 기록" aria-busy={loading}>
    <div className="issue-automation-heading">
      <h3><Workflow size={16} aria-hidden="true" />GitLab 상태 자동화 기록</h3>
      <button type="button" className="btn btn-ghost" aria-label="자동화 기록 새로고침" disabled={loading} onClick={() => void load({ refreshIssue: true })}>
        <RefreshCw size={14} aria-hidden="true" />새로고침
      </button>
    </div>
    {error && <p className="issue-form-error" role="alert">{error}</p>}
    {history && !loading && !error && history.issueVersion !== issueVersion && <p className="issue-section-empty" role="status">
      다른 변경사항이 있습니다. 새로고침으로 최신 업무를 확인하세요.
    </p>}
    {!history?.items.length && !error && <p className="issue-section-empty" role="status">
      {loading ? '자동화 기록을 불러오는 중입니다.' : '이 업무의 자동화 기록이 없습니다.'}
    </p>}
    {Boolean(history?.items.length) && <ol className="issue-automation-runs">
      {history?.items.map(run => {
        const context = run.context;
        const url = sourceUrl(run, links);
        const time = run.occurredAt || run.createdAt;
        const actor = users.find(user => user.id === run.actorId);
        const canEdit = current && history.latestBlockedRunId === run.id && canPrepareStatus(run);
        return <li key={run.id}>
          <div className="issue-automation-transition">
            <span className="issue-automation-outcome" data-outcome={run.outcome}>{outcomes[run.outcome]}</span>
            <strong>{context?.fromStatusLabel ?? run.fromStatus} <span aria-label="에서">→</span> {context?.toStatusLabel ?? run.toStatus}</strong>
          </div>
          <p className="issue-automation-reason">{run.reason}</p>
          {context && <div className="issue-automation-context">
            <span>{context.ruleName} · {AUTOMATION_TRIGGER_LABELS[context.trigger]}</span>
            <span>저장소 #{context.gitlabProjectId}{context.objectId && ` · 객체 #${context.objectId}`}{context.branch && <> · <code>{context.branch}</code></>}</span>
          </div>}
          <div className="issue-automation-meta">
            <span>{run.occurredAt ? '이벤트 시각' : '기록 시각'} <time dateTime={time}>{new Date(time).toLocaleString('ko-KR')}</time></span>
            {actor && <span>실행 팀원 {actor.name}</span>}
          </div>
          {(url || canEdit) && <div className="issue-automation-actions">
            {url && <a className="btn btn-ghost" href={url.href} target="_blank" rel="noopener noreferrer">GitLab 원본 열기 <ExternalLink size={13} aria-hidden="true" /></a>}
            {canEdit && <button type="button" className="btn" onClick={() => onPrepareStatus(run)}>
              목표 상태로 편집 <ArrowRight size={13} aria-hidden="true" />
            </button>}
          </div>}
        </li>;
      })}
    </ol>}
    {history?.nextCursor && <button type="button" className="btn btn-ghost issue-automation-older" disabled={loading || history.issueVersion !== issueVersion}
      onClick={() => void load({ before: history.nextCursor ?? undefined })}>이전 기록 보기</button>}
  </section>;
}
