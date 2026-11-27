'use client';

import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { IssueChangeHistoryEntry, IssueChangeHistoryPage } from '../../shared/types';
import { api } from '../lib/api';
import './issue-change-history.css';

type ChangeValue = IssueChangeHistoryEntry['changes'][number]['before'];
type PageRequest = { issueVersion: number; beforeVersion?: number };
type ReadResult = { request: PageRequest; page?: IssueChangeHistoryPage; failed?: true };

function valueText({ display, value }: ChangeValue) {
  if (display !== null) return display || '값 없음';
  if (Array.isArray(value)) return value.join(', ') || '값 없음';
  if (typeof value === 'boolean') return value ? '예' : '아니요';
  return value === null || value === '' ? '값 없음' : String(value);
}

function HistoryValue({ label, value }: { label: string; value: ChangeValue }) {
  return <div>
    <dt>{label}</dt>
    <dd>{valueText(value)}{value.truncated && <small>일부만 표시</small>}</dd>
  </div>;
}

export function IssueChangeHistory({ issueId, issueVersion }: { issueId: string; issueVersion: number }) {
  const [request, setRequest] = useState<PageRequest>({ issueVersion });
  const [result, setResult] = useState<ReadResult | null>(null);
  if (request.issueVersion !== issueVersion) setRequest({ issueVersion });

  const pending = result?.request !== request;
  const page = result?.request.issueVersion === issueVersion ? result?.page : undefined;
  const failed = !pending && result?.failed;

  useEffect(() => {
    const controller = new AbortController();
    const query = request.beforeVersion === undefined ? '' : `?beforeVersion=${request.beforeVersion}`;
    void api<IssueChangeHistoryPage>(`/issues/${encodeURIComponent(issueId)}/change-history${query}`, {
      signal: controller.signal,
      cache: 'no-store',
    }).then(response => {
      if (controller.signal.aborted) return;
      setResult(previous => {
        const earlier = request.beforeVersion !== undefined && previous?.request.issueVersion === request.issueVersion ? previous.page : undefined;
        return { request, page: earlier ? { ...response, entries: [...earlier.entries, ...response.entries] } : response };
      });
    }).catch(() => {
      if (!controller.signal.aborted) setResult(previous => ({ request, page: previous?.request.issueVersion === request.issueVersion ? previous.page : undefined, failed: true }));
    });
    return () => controller.abort();
  }, [issueId, request]);

  useEffect(() => {
    function reloadAfterImport() {
      setResult(null);
      setRequest({ issueVersion });
    }
    window.addEventListener('donefac:workspace-imported', reloadAfterImport);
    return () => window.removeEventListener('donefac:workspace-imported', reloadAfterImport);
  }, [issueVersion]);

  return <section className="issue-field-history" aria-label="필드 변경 기록">
    <header className="issue-field-history-heading">
      <h3>필드 변경 기록</h3>
      <button type="button" className="btn btn-ghost" aria-label="필드 변경 새로고침" disabled={pending}
        onClick={() => setRequest({ issueVersion })}><RefreshCw size={14} aria-hidden="true" />새로고침</button>
    </header>
    {pending && <p className="issue-section-empty" role="status">필드 변경 기록을 불러오는 중…</p>}
    {failed && <div className="issue-field-history-error">
      <p className="issue-form-error" role="alert">필드 변경 기록을 불러오지 못했습니다.</p>
      <button type="button" className="btn" onClick={() => setRequest({ ...request })}>다시 불러오기</button>
    </div>}
    {!pending && !failed && !page?.entries.length && <p className="issue-section-empty">기록된 필드 변경이 없습니다.</p>}
    {!!page?.entries.length && <ol className="issue-field-history-entries" role="list" aria-label="필드 변경 목록" aria-busy={pending}>
      {page.entries.map(entry => <li key={entry.id}>
        <div className="issue-field-history-meta">
          <strong>{entry.actorName || '시스템'}</strong>
          <span>{entry.origin === 'automation' ? '자동화' : '사용자 변경'}</span>
          <time dateTime={entry.occurredAt}>{new Date(entry.occurredAt).toLocaleString('ko-KR')}</time>
        </div>
        {entry.changes.map(change => <div key={change.field} className="issue-field-history-change">
          <h4>{change.label}</h4>
          <dl>
            <HistoryValue label="변경 전" value={change.before} />
            <HistoryValue label="변경 후" value={change.after} />
          </dl>
        </div>)}
      </li>)}
    </ol>}
    {page && page.nextBeforeVersion !== null && <button type="button" className="btn btn-ghost issue-field-history-more" disabled={pending}
      onClick={() => {
        if (page.nextBeforeVersion !== null) setRequest({ issueVersion, beforeVersion: page.nextBeforeVersion });
      }}>이전 변경 더 보기</button>}
  </section>;
}
