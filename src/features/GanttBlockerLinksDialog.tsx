'use client';

import { useEffect, useId, useState, type Ref } from 'react';
import {
  MAX_SCHEDULE_BLOCKER_LINKS,
  SCHEDULE_BLOCKER_LINK_PAGE_SIZE,
  type Dependency,
  type Issue,
  type Project,
  type ScheduleBlockerLinkCandidate,
  type ScheduleBlockerLinkPage,
  type TeamScheduleBlocker,
} from '../../shared/types';
import { api } from '../lib/api';
import { dependencyLabel, errorMessage } from './schedule-utils';

export type BlockerLinkSelection = ReadonlyMap<string, ScheduleBlockerLinkCandidate>;

type PageResult = {
  projectId: string | null;
  offset: number;
  refreshKey: number;
  attempt: number;
} & ({ page: ScheduleBlockerLinkPage; error?: never } | { page?: never; error: string });

export function GanttBlockerLinkPicker({
  projectId, projects, projectFilterRef, issues, dependencyFor, selection, refreshKey, onChange,
}: {
  projectId: string | null;
  projects?: readonly Project[];
  projectFilterRef?: Ref<HTMLSelectElement>;
  issues: ReadonlyMap<string, Issue>;
  dependencyFor: (relation: TeamScheduleBlocker) => Dependency | undefined;
  selection: BlockerLinkSelection;
  refreshKey: number;
  onChange: (selection: BlockerLinkSelection) => void;
}) {
  const [scope, setScope] = useState<{ projectId: string | null; offset: number }>({ projectId, offset: 0 });
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<PageResult | null>(null);
  const projectLabelPrefix = useId();
  const { offset, projectId: targetProject } = scope;
  const team = projectId === null;
  const current = result && result.projectId === targetProject && result.offset === offset &&
    result.refreshKey === refreshKey && result.attempt === attempt ? result : null;
  const page = current?.page;

  useEffect(() => {
    const controller = new AbortController();
    const cursor = { projectId: targetProject, offset, refreshKey, attempt };
    const query = new URLSearchParams(targetProject === null ? { scope: 'team' } : { projectId: targetProject });
    query.set('offset', String(offset));
    void api<ScheduleBlockerLinkPage>(`/schedule/blocker-links?${query}`, { signal: controller.signal })
      .then(latest => {
        if (controller.signal.aborted) return;
        if (offset > 0 && offset >= latest.total) {
          const lastPage = Math.max(0, Math.floor((latest.total - 1) / SCHEDULE_BLOCKER_LINK_PAGE_SIZE) * SCHEDULE_BLOCKER_LINK_PAGE_SIZE);
          setScope(active => active.projectId === targetProject && active.offset === offset ? { ...active, offset: lastPage } : active);
          return;
        }
        const items = team && targetProject !== null ? latest.items.map(relation => ({ ...relation, projectId: targetProject })) : latest.items;
        setResult({ ...cursor, page: { ...latest, items } });
      })
      .catch(cause => {
        if (!controller.signal.aborted) setResult({ ...cursor, error: errorMessage(cause) });
      });
    return () => controller.abort();
  }, [team, targetProject, offset, refreshKey, attempt]);

  const projectsById = new Map(projects?.map(project => [project.id, project]));
  const projectLabel = (relation: ScheduleBlockerLinkCandidate) => {
    if (!team || !relation.projectId) return undefined;
    const project = projectsById.get(relation.projectId);
    return project ? `${project.key} · ${project.name}` : '프로젝트 정보 없음';
  };
  const rows = (page?.items ?? []).map(relation => {
    const source = issues.get(relation.sourceIssueId);
    const target = issues.get(relation.targetIssueId);
    const picked = selection.get(relation.id);
    return {
      relation, source, target, picked, dependency: dependencyFor(relation),
      available: Boolean(source && target && (!team || (relation.projectId && source.projectId === relation.projectId && target.projectId === relation.projectId))),
      changed: Boolean(picked && (picked.version !== relation.version || picked.projectId !== relation.projectId ||
        picked.sourceIssueId !== relation.sourceIssueId || picked.targetIssueId !== relation.targetIssueId)),
    };
  });
  const missing = rows.filter(row => row.available && !row.dependency && !row.picked);
  const atLimit = selection.size >= MAX_SCHEDULE_BLOCKER_LINKS;
  const candidateName = (relation: TeamScheduleBlocker) =>
    `${issues.get(relation.sourceIssueId)?.key ?? '선행 업무'} → ${issues.get(relation.targetIssueId)?.key ?? '후행 업무'}`;

  function toggle(relation: ScheduleBlockerLinkCandidate, checked: boolean) {
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

  const lastScopePage = result && result.projectId === targetProject && result.attempt === attempt ? result.page : undefined;
  const total = (page ?? lastScopePage)?.total ?? 0;
  return (
    <section className="schedule-blocker-links" aria-label="차단 관계 목록">
      {team && <label className="schedule-blocker-project-filter">차단 관계 프로젝트
        <select ref={projectFilterRef} className="field" value={targetProject ?? ''} onChange={event => {
          setScope({ projectId: event.currentTarget.value || null, offset: 0 });
          setAttempt(value => value + 1);
        }}>
          <option value="">전체 프로젝트</option>
          {targetProject && !projectsById.has(targetProject) && <option value={targetProject} disabled>프로젝트 정보 없음</option>}
          {projects?.map(project => <option key={project.id} value={project.id}>{project.key} · {project.name}</option>)}
        </select>
      </label>}
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
                <span>{candidateName(relation)}{team && <small className="schedule-bulk-project" data-schedule-project={relation.projectId}>{projectLabel(relation)}</small>}</span>
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
      {page && page.total === 0 && <p>{targetProject === null ? '확인할 차단 관계가 없습니다.' : '이 프로젝트에 확인할 차단 관계가 없습니다.'}</p>}
      {rows.length > 0 && (
        <ul className="schedule-blocker-list">
          {rows.map(({ relation, source, target, picked, dependency, available, changed }) => {
            const label = projectLabel(relation);
            const projectLabelId = label ? `${projectLabelPrefix}-${relation.id}` : undefined;
            return <li key={relation.id}>
              <label>
                <input type="checkbox" aria-label={`${candidateName(relation)} 차단 관계 선택`}
                  aria-describedby={projectLabelId} checked={Boolean(picked)} disabled={!picked && (atLimit || !available)}
                  onChange={event => toggle(relation, event.currentTarget.checked)} />
                <span className="schedule-blocker-endpoints">
                  <span><strong>{source?.key ?? '업무 정보 없음'}</strong> {source?.title}</span>
                  <span aria-hidden="true">→</span>
                  <span><strong>{target?.key ?? '업무 정보 없음'}</strong> {target?.title}</span>
                </span>
              </label>
              <small className="schedule-blocker-rule">
                {label && <span id={projectLabelId} data-schedule-project={relation.projectId}>{label}</span>}
                {relation.origin === 'jira' && <span>Jira 이관</span>}
                <span>{dependency ? `이미 연결 · ${dependencyLabel(dependency)}` : '일정 미연결'}</span>
                {changed && <span className="schedule-blocker-changed">관계 변경됨 · 선택을 해제한 뒤 다시 선택해 주세요.</span>}
              </small>
            </li>;
          })}
        </ul>
      )}
      {total > SCHEDULE_BLOCKER_LINK_PAGE_SIZE && (
        <div className="schedule-paste-pagination">
          <span>{offset + 1}–{Math.min(offset + SCHEDULE_BLOCKER_LINK_PAGE_SIZE, total)} / {total}</span>
          <button className="btn btn-ghost" type="button" aria-label="차단 관계 이전 페이지" disabled={offset === 0}
            onClick={() => setScope({ ...scope, offset: Math.max(0, offset - SCHEDULE_BLOCKER_LINK_PAGE_SIZE) })}>
            이전
          </button>
          <button className="btn btn-ghost" type="button" aria-label="차단 관계 다음 페이지" disabled={offset + SCHEDULE_BLOCKER_LINK_PAGE_SIZE >= total}
            onClick={() => setScope({ ...scope, offset: offset + SCHEDULE_BLOCKER_LINK_PAGE_SIZE })}>
            다음
          </button>
        </div>
      )}
    </section>
  );
}
