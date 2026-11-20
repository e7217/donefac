'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import type { JiraIssueStatusHistoryEntry, JiraIssueStatusHistoryPage, SourceRecordArchive } from '../../shared/types';
import { api } from '../lib/api';
import { SourceArchiveDetail } from './SourceOrigins';
import './issue-jira-status-history.css';

const pageSize = 50;
type PageRequest = { offset: number };
type ReadResult = { request: PageRequest; page?: JiraIssueStatusHistoryPage; failed?: true };

function statusName(status: JiraIssueStatusHistoryEntry['from']): string {
  return status.label || (status.id ? `상태 ID ${status.id}` : '상태 정보 없음');
}

export function IssueJiraStatusHistory({ issueId }: { issueId: string }) {
  const [request, setRequest] = useState<PageRequest>({ offset: 0 });
  const [result, setResult] = useState<ReadResult | null>(null);
  const [openEntryId, setOpenEntryId] = useState<string | null>(null);
  const originTrigger = useRef<HTMLButtonElement>(null);
  const originId = useId();
  const pending = result?.request !== request;
  const page = result?.page;
  const failed = !pending && result?.failed;

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ offset: String(request.offset), limit: String(pageSize) });
    void api<JiraIssueStatusHistoryPage>(`/issues/${encodeURIComponent(issueId)}/jira-status-history?${query}`, {
      signal: controller.signal,
      cache: 'no-store',
    }).then(response => {
      if (!controller.signal.aborted) setResult({ request, page: response });
    }).catch(() => {
      if (!controller.signal.aborted) setResult(previous => ({ request, page: previous?.page, failed: true }));
    });
    return () => controller.abort();
  }, [issueId, request]);

  if (!pending && !failed && page?.total === 0) return null;
  function selectPage(offset: number) {
    setOpenEntryId(null);
    setRequest({ offset });
  }
  function closeOrigin() {
    setOpenEntryId(null);
    originTrigger.current?.focus({ preventScroll: true });
  }
  return <section className="issue-jira-status-history" aria-label="Jira 상태 변경 이력">
    <h3>Jira 상태 변경 이력</h3>
    {pending && <p role="status">Jira 상태 변경을 불러오는 중…</p>}
    {failed && <div className="issue-jira-status-error">
      <p role="alert">Jira 상태 변경을 불러오지 못했습니다.</p>
      <button type="button" className="btn" onClick={() => selectPage(request.offset)}>다시 불러오기</button>
    </div>}
    {page && <div aria-busy={pending}>
      <ol className="issue-jira-status-entries" role="list" aria-label="이관한 상태 변경 목록">
        {page.entries.map((entry, index) => <li key={entry.id}>
          <div className="issue-jira-status-transition">
            <span className="sr-only">이전 상태 </span>
            <strong>{statusName(entry.from)}</strong>
            <ArrowRight size={14} aria-hidden="true" />
            <span className="sr-only">변경 후 상태 </span>
            <strong>{statusName(entry.to)}</strong>
          </div>
          <div className="issue-jira-status-meta">
            <span>{entry.originalAuthorName || '작성자 정보 없음'}</span>
            {entry.changedAt && Number.isFinite(Date.parse(entry.changedAt))
              ? <time dateTime={entry.changedAt} title={entry.originalChangedAt || undefined}>{new Date(entry.changedAt).toLocaleString('ko-KR')}</time>
              : <span>{entry.originalChangedAt ? `원본 시각 ${entry.originalChangedAt}` : '시각 정보 없음'}</span>}
            <button className="btn btn-ghost" type="button" aria-label={`${page.offset + index + 1}번째 Jira 상태 변경 원본 기록`}
              aria-expanded={openEntryId === entry.id} aria-controls={openEntryId === entry.id ? originId : undefined}
              onClick={event => {
                if (openEntryId === entry.id) {
                  closeOrigin();
                } else {
                  originTrigger.current = event.currentTarget;
                  setOpenEntryId(entry.id);
                }
              }}>원본 기록</button>
          </div>
          {openEntryId === entry.id && <JiraStatusHistoryOrigin id={originId} entry={entry} onClose={closeOrigin} />}
        </li>)}
      </ol>
      {(page.offset > 0 || page.total > page.limit) && <div className="issue-jira-status-pages" role="group" aria-label="Jira 상태 변경 이력 페이지">
        <span>{page.entries.length ? `${page.offset + 1}–${page.offset + page.entries.length}` : '0'} / {page.total.toLocaleString()}건</span>
        <button className="btn btn-ghost" type="button" aria-label="Jira 상태 변경 이전 페이지"
          disabled={pending || page.offset === 0} onClick={() => selectPage(Math.max(0, page.offset - page.limit))}>이전</button>
        <button className="btn btn-ghost" type="button" aria-label="Jira 상태 변경 다음 페이지"
          disabled={pending || page.offset + page.limit >= page.total} onClick={() => selectPage(page.offset + page.limit)}>다음</button>
      </div>}
    </div>}
  </section>;
}

function JiraStatusHistoryOrigin({ id, entry, onClose }: { id: string; entry: JiraIssueStatusHistoryEntry; onClose: () => void }) {
  const { sourceImportId, sourceRecordId, originalAuthorName } = entry;
  const wrapper = useRef<HTMLDivElement>(null);
  const [archive, setArchive] = useState<SourceRecordArchive | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => { wrapper.current?.focus(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    const path = `/source-imports/${encodeURIComponent(sourceImportId)}/records/${encodeURIComponent(sourceRecordId)}`;
    void api<SourceRecordArchive>(path, { signal: controller.signal, cache: 'no-store' }).then(value => {
      if (!controller.signal.aborted) setArchive(value);
    }).catch(() => {
      if (!controller.signal.aborted) setFailed(true);
    });
    return () => controller.abort();
  }, [sourceImportId, sourceRecordId, attempt]);

  return <div ref={wrapper} id={id} tabIndex={-1} role="group" aria-label="Jira 상태 변경 원본 기록" className="issue-jira-status-origin">
    {archive ? <SourceArchiveDetail archive={archive} originalAuthorName={originalAuthorName} onClose={onClose} /> : <>
      {failed ? <>
        <p role="alert">Jira 원본 기록을 불러오지 못했습니다.</p>
        <button type="button" className="btn" onClick={() => {
          setFailed(false);
          setAttempt(value => value + 1);
        }}>원본 다시 불러오기</button>
      </> : <p role="status">Jira 원본 기록을 불러오는 중…</p>}
      <button type="button" className="btn btn-ghost" onClick={onClose}>닫기</button>
    </>}
  </div>;
}
