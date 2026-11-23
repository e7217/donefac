'use client';

import { useEffect, useState } from 'react';
import {
  MAX_SCHEDULE_BLOCKER_LINKS,
  SCHEDULE_BLOCKER_LINK_PAGE_SIZE,
  type Dependency,
  type Issue,
  type ScheduleBlockerLinkPage,
  type TeamScheduleBlocker,
} from '../../shared/types';
import { api } from '../lib/api';
import { dependencyLabel, errorMessage } from './schedule-utils';

export type BlockerLinkSelection = ReadonlyMap<string, TeamScheduleBlocker>;

type PageResult = {
  offset: number;
  refreshKey: number;
  attempt: number;
} & ({ page: ScheduleBlockerLinkPage; error?: never } | { page?: never; error: string });

export function GanttBlockerLinkPicker({
  projectId, issues, dependencyFor, selection, refreshKey, onChange,
}: {
  projectId: string;
  issues: ReadonlyMap<string, Issue>;
  dependencyFor: (relation: TeamScheduleBlocker) => Dependency | undefined;
  selection: BlockerLinkSelection;
  refreshKey: number;
  onChange: (selection: BlockerLinkSelection) => void;
}) {
  const [offset, setOffset] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<PageResult | null>(null);
  const current = result?.offset === offset && result.refreshKey === refreshKey && result.attempt === attempt ? result : null;
  const page = current?.page;

  useEffect(() => {
    const controller = new AbortController();
    const cursor = { offset, refreshKey, attempt };
    const query = new URLSearchParams({ projectId, offset: String(offset) });
    void api<ScheduleBlockerLinkPage>(`/schedule/blocker-links?${query}`, { signal: controller.signal })
      .then(latest => {
        if (controller.signal.aborted) return;
        if (offset > 0 && offset >= latest.total) {
          setOffset(Math.max(0, Math.floor((latest.total - 1) / SCHEDULE_BLOCKER_LINK_PAGE_SIZE) * SCHEDULE_BLOCKER_LINK_PAGE_SIZE));
          return;
        }
        setResult({ ...cursor, page: latest });
      })
      .catch(cause => {
        if (!controller.signal.aborted) setResult({ ...cursor, error: errorMessage(cause) });
      });
    return () => controller.abort();
  }, [projectId, offset, refreshKey, attempt]);

  const rows = (page?.items ?? []).map(relation => {
    const source = issues.get(relation.sourceIssueId);
    const target = issues.get(relation.targetIssueId);
    const picked = selection.get(relation.id);
    return {
      relation, source, target, picked, dependency: dependencyFor(relation),
      changed: Boolean(picked && picked.version !== relation.version),
    };
  });
  const missing = rows.filter(row => row.source && row.target && !row.dependency && !row.picked);
  const atLimit = selection.size >= MAX_SCHEDULE_BLOCKER_LINKS;
  const candidateName = (relation: TeamScheduleBlocker) =>
    `${issues.get(relation.sourceIssueId)?.key ?? '선행 업무'} → ${issues.get(relation.targetIssueId)?.key ?? '후행 업무'}`;

  function toggle(relation: TeamScheduleBlocker, checked: boolean) {
    if (checked && atLimit) return;
    const next = new Map(selection);
    if (checked) next.set(relation.id, relation);
    else next.delete(relation.id);
    onChange(next);
  }

  function selectMissing() {
    const next = new Map(selection);
    for (const { relation } of missing.slice(0, MAX_SCHEDULE_BLOCKER_LINKS - next.size)) next.set(relation.id, relation);
    onChange(next);
  }

  const total = (page ?? result?.page)?.total ?? 0;
  return (
    <section className="schedule-blocker-links" aria-label="차단 관계 목록">
      <div className="schedule-blocker-toolbar">
        <span role="status">선택 {selection.size}건 / 최대 {MAX_SCHEDULE_BLOCKER_LINKS}건</span>
        <button className="btn" type="button" disabled={atLimit || missing.length === 0} onClick={selectMissing}>
          이 페이지의 미연결 차단 관계 선택
        </button>
      </div>
      {selection.size > 0 && (
        <details className="schedule-blocker-selected">
          <summary>선택한 차단 관계 {selection.size}건</summary>
          <ul>
            {[...selection.values()].map(relation => (
              <li key={relation.id}>
                <span>{candidateName(relation)}</span>
                <button className="btn btn-ghost" type="button" aria-label={`${candidateName(relation)} 선택 해제`}
                  onClick={() => toggle(relation, false)}>
                  선택 해제
                </button>
              </li>
            ))}
          </ul>
          <button className="btn btn-ghost" type="button" onClick={() => onChange(new Map())}>선택 모두 해제</button>
        </details>
      )}
      {!current && <p role="status">차단 관계를 불러오는 중입니다.</p>}
      {current?.error && (
        <>
          <p className="schedule-paste-error" role="alert">{current.error}</p>
          <button className="btn" type="button" onClick={() => setAttempt(value => value + 1)}>차단 관계 다시 불러오기</button>
        </>
      )}
      {page && page.total === 0 && <p>이 프로젝트에 확인할 차단 관계가 없습니다.</p>}
      {rows.length > 0 && (
        <ul className="schedule-blocker-list">
          {rows.map(({ relation, source, target, picked, dependency, changed }) => (
            <li key={relation.id}>
              <label>
                <input type="checkbox" aria-label={`${candidateName(relation)} 차단 관계 선택`}
                  checked={Boolean(picked)} disabled={!picked && (atLimit || !source || !target)}
                  onChange={event => toggle(relation, event.currentTarget.checked)} />
                <span className="schedule-blocker-endpoints">
                  <span><strong>{source?.key ?? '업무 정보 없음'}</strong> {source?.title}</span>
                  <span aria-hidden="true">→</span>
                  <span><strong>{target?.key ?? '업무 정보 없음'}</strong> {target?.title}</span>
                </span>
              </label>
              <small className="schedule-blocker-rule">
                {relation.origin === 'jira' && <span>Jira 이관</span>}
                <span>{dependency ? `이미 연결 · ${dependencyLabel(dependency)}` : '일정 미연결'}</span>
                {changed && <span className="schedule-blocker-changed">관계 변경됨 · 선택을 해제한 뒤 다시 선택해 주세요.</span>}
              </small>
            </li>
          ))}
        </ul>
      )}
      {total > SCHEDULE_BLOCKER_LINK_PAGE_SIZE && (
        <div className="schedule-paste-pagination">
          <span>{offset + 1}–{Math.min(offset + SCHEDULE_BLOCKER_LINK_PAGE_SIZE, total)} / {total}</span>
          <button className="btn btn-ghost" type="button" aria-label="차단 관계 이전 페이지" disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - SCHEDULE_BLOCKER_LINK_PAGE_SIZE))}>
            이전
          </button>
          <button className="btn btn-ghost" type="button" aria-label="차단 관계 다음 페이지" disabled={offset + SCHEDULE_BLOCKER_LINK_PAGE_SIZE >= total}
            onClick={() => setOffset(offset + SCHEDULE_BLOCKER_LINK_PAGE_SIZE)}>
            다음
          </button>
        </div>
      )}
    </section>
  );
}
