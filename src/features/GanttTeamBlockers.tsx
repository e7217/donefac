'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type PointerEventHandler } from 'react';
import { ArrowLeft, ArrowRight, CalendarDays, Link2, Plus, RefreshCw, X } from 'lucide-react';
import type { ScheduleDependencyEndpoint } from '../../shared/schedule-dependencies';
import type { FeatureProps, Issue, IssueRelation, TeamScheduleBlocker, WorkspaceSnapshot } from '../../shared/types';
import { isTerminalStatus } from '../../shared/workflow-helpers';
import { issueSearchAliasLabel, searchIssueCandidates } from '../../shared/workspace-search';
import { api } from '../lib/api';
import type { TeamFollowUpChoice } from './GanttTeamFollowUpChooser';
import { errorMessage } from './schedule-utils';
import './gantt-team-blockers.css';

const ROWS_PER_PAGE = 8;
const ISSUE_MATCH_LIMIT = 40;

type Props = Pick<FeatureProps, 'data' | 'openIssue' | 'refresh' | 'notify'> & {
  id: string;
  visibleIssueIds: ReadonlySet<string>;
  selectedIssueIds: readonly string[];
  busy: boolean;
  onClose: () => void;
  onDraftChange: (dirty: boolean, pending: boolean) => void;
  onLocateIssueDate: (id: string, endpoint: ScheduleDependencyEndpoint) => boolean;
  onReviewSchedule: (relation: TeamScheduleBlocker, source: Issue, target: Issue, opener: HTMLButtonElement) => void;
  onReviewTogether: (source: Issue, choices: readonly TeamFollowUpChoice[], opener: HTMLButtonElement) => void;
  onPointerDown: PointerEventHandler<HTMLButtonElement>;
};

interface Draft {
  sourceId: string;
  targetId: string;
  sourceQuery: string;
  targetQuery: string;
  initialTargetId: string;
}

export function GanttTeamBlockers({
  id, data, visibleIssueIds, selectedIssueIds, busy, openIssue, refresh, notify,
  onClose, onDraftChange, onLocateIssueDate, onReviewSchedule, onReviewTogether, onPointerDown,
}: Props) {
  const heading = useId();
  const formHeading = useId();
  const [relations, setRelations] = useState<TeamScheduleBlocker[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const getRequest = useRef<AbortController | null>(null);
  const saveRequest = useRef<AbortController | null>(null);
  const refreshRequest = useRef<AbortController | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const sourceSearch = useRef<HTMLInputElement>(null);
  const restoreAddFocus = useRef(false);
  const { issues, projects, workflows, issueSchemas } = data;

  const projectNames = useMemo(() => new Map(projects.map(project => [project.id, project.name])), [projects]);
  const activeIssues = useMemo(() => issues.filter(issue => projectNames.has(issue.projectId) &&
    !isTerminalStatus({ workflows, issueSchemas }, issue.projectId, issue.status)), [issues, projectNames, workflows, issueSchemas]);
  const activeById = useMemo(() => new Map(activeIssues.map(issue => [issue.id, issue])), [activeIssues]);
  const activeRows = useMemo(() => relations.flatMap(relation => {
    const source = activeById.get(relation.sourceIssueId);
    const target = activeById.get(relation.targetIssueId);
    return source && target && source.projectId !== target.projectId ? [{ relation, source, target }] : [];
  }), [relations, activeById]);
  const reviewChoices = useMemo(() => {
    const bySource = new Map<string, TeamFollowUpChoice[]>();
    for (const { source, relation, target } of activeRows) {
      const choices = bySource.get(source.id);
      if (choices) choices.push({ relation, target });
      else bySource.set(source.id, [{ relation, target }]);
    }
    for (const choices of bySource.values()) choices.sort((a, b) => a.target.key.localeCompare(b.target.key, 'ko', { numeric: true }));
    return bySource;
  }, [activeRows]);
  const rows = useMemo(() => activeRows.filter(({ source, target }) => visibleIssueIds.has(source.id) || visibleIssueIds.has(target.id))
    .sort((a, b) => (a.target.startDate ?? a.target.endDate ?? '9999-12-31').localeCompare(b.target.startDate ?? b.target.endDate ?? '9999-12-31') ||
    a.target.key.localeCompare(b.target.key, 'ko', { numeric: true }) || a.source.key.localeCompare(b.source.key, 'ko', { numeric: true }) ||
    a.relation.id.localeCompare(b.relation.id)), [activeRows, visibleIssueIds]);
  const lastPage = Math.max(0, Math.ceil(rows.length / ROWS_PER_PAGE) - 1);
  const currentPage = Math.min(page, lastPage);
  const offset = currentPage * ROWS_PER_PAGE;
  const pageRows = rows.slice(offset, offset + ROWS_PER_PAGE);

  const source = draft && activeById.get(draft.sourceId);
  const target = draft && activeById.get(draft.targetId);
  const dirty = Boolean(draft && (draft.sourceId || draft.targetId !== draft.initialTargetId ||
    draft.sourceQuery.trim() || draft.targetQuery.trim()));
  const duplicate = Boolean(source && target && relations.some(relation => relation.origin !== 'jira' &&
    relation.sourceIssueId === source.id && relation.targetIssueId === target.id));
  const invalidPair = Boolean(source && target && source.projectId === target.projectId);
  const unavailable = Boolean(draft && ((draft.sourceId && !source) || (draft.targetId && !target)));
  const disabled = busy || saving;
  const draftOpen = draft !== null;

  const load = useCallback(async () => {
    getRequest.current?.abort();
    const request = new AbortController();
    getRequest.current = request;
    setLoading(true);
    try {
      const updated = await api<TeamScheduleBlocker[]>('/schedule/team-blockers', { signal: request.signal });
      if (!request.signal.aborted) {
        setRelations(updated);
        setLoadError('');
        return updated;
      }
    } catch (cause) {
      if (!request.signal.aborted) setLoadError(errorMessage(cause));
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const reload = () => { if (!saveRequest.current && !refreshRequest.current) void load(); };
    const timer = setTimeout(reload, 0);
    window.addEventListener('teamspace:trash-changed', reload);
    window.addEventListener('teamspace:workspace-imported', reload);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('teamspace:trash-changed', reload);
      window.removeEventListener('teamspace:workspace-imported', reload);
    };
  }, [issues, load]);

  useEffect(() => () => {
    getRequest.current?.abort();
    saveRequest.current?.abort();
    refreshRequest.current?.abort();
  }, []);

  useLayoutEffect(() => {
    onDraftChange(dirty, saving);
    return () => onDraftChange(false, false);
  }, [dirty, saving, onDraftChange]);

  useLayoutEffect(() => { if (draftOpen) sourceSearch.current?.focus(); }, [draftOpen]);

  useLayoutEffect(() => {
    if (draftOpen || disabled || !restoreAddFocus.current) return;
    restoreAddFocus.current = false;
    addButton.current?.focus({ preventScroll: true });
  }, [draftOpen, disabled]);

  function startDraft() {
    const selected = selectedIssueIds.length === 1 ? selectedIssueIds[0] : '';
    const initialTargetId = visibleIssueIds.has(selected) && activeById.has(selected) ? selected : '';
    setSaveError('');
    setDraft({ sourceId: '', targetId: initialTargetId, sourceQuery: '', targetQuery: '', initialTargetId });
  }

  function changeDraft(values: Partial<Draft>) {
    setDraft(previous => previous && { ...previous, ...values });
    setSaveError('');
  }

  function cancelDraft() {
    if (dirty && !window.confirm('입력한 차단 관계를 취소하시겠습니까?')) return;
    restoreAddFocus.current = true;
    setDraft(null);
    setSaveError('');
  }

  async function refreshList() {
    if (refreshRequest.current || saveRequest.current) return;
    const request = new AbortController();
    refreshRequest.current = request;
    setRefreshing(true);
    try {
      await refresh();
    } catch (cause) {
      if (!request.signal.aborted) notify(`업무 목록을 새로고침하지 못했습니다. ${errorMessage(cause)}`, 'error');
    } finally {
      if (!request.signal.aborted) {
        await load();
        if (!request.signal.aborted) setRefreshing(false);
      }
      refreshRequest.current = null;
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!source || !target || invalidPair || duplicate || disabled || loading || refreshing || saveRequest.current) return;
    const request = new AbortController();
    saveRequest.current = request;
    getRequest.current?.abort();
    onDraftChange(dirty, true);
    setSaving(true);
    setSaveError('');
    try {
      let relation: TeamScheduleBlocker | undefined;
      try {
        const { id, sourceIssueId, targetIssueId, version } = await api<IssueRelation>(`/issues/${encodeURIComponent(source.id)}/relations`, {
          method: 'POST', signal: request.signal,
          body: JSON.stringify({ otherIssueId: target.id, type: 'blocks', direction: 'outgoing' }),
        });
        relation = { id, sourceIssueId, targetIssueId, version };
      } catch (cause) {
        if (request.signal.aborted) return;
        const current = await load();
        if (request.signal.aborted) return;
        relation = current?.find(row => row.origin !== 'jira' && row.sourceIssueId === source.id && row.targetIssueId === target.id);
        if (!relation) {
          setSaveError(errorMessage(cause));
          return;
        }
      }
      if (request.signal.aborted) return;
      const saved = relation;
      setRelations(previous => [...previous.filter(row => row.id !== saved.id &&
        !(row.origin === 'jira' && row.sourceIssueId === saved.sourceIssueId && row.targetIssueId === saved.targetIssueId)), saved]);
      setPage(0);
      restoreAddFocus.current = true;
      setDraft(null);
      const outsideView = !visibleIssueIds.has(source.id) && !visibleIssueIds.has(target.id);
      notify(`${source.key} → ${target.key} 차단 관계를 저장했습니다.${outsideView ? ' 두 업무가 모두 현재 보기 범위 밖에 있습니다.' : ''}`);
      try {
        await refresh();
      } catch (cause) {
        if (!request.signal.aborted) notify(`업무 목록을 새로고침하지 못했습니다. ${errorMessage(cause)}`, 'error');
      }
      if (!request.signal.aborted) await load();
    } finally {
      if (!request.signal.aborted) {
        saveRequest.current = null;
        setSaving(false);
      }
    }
  }

  return <section id={id} className="gantt-team-blockers card" aria-labelledby={heading}>
    <header className="gantt-team-blockers-header">
      <h2 id={heading}><Link2 size={17} aria-hidden="true" />프로젝트 간 차단</h2>
      <div className="gantt-team-blockers-actions">
        <button ref={addButton} type="button" className="btn btn-ghost" aria-expanded={draftOpen}
          aria-controls={draftOpen ? `${formHeading}-form` : undefined} disabled={disabled || draftOpen} onClick={startDraft}>
          <Plus size={15} aria-hidden="true" />차단 관계 추가
        </button>
        <button type="button" className="issue-icon-button" aria-label="차단 관계 새로고침"
          disabled={disabled || refreshing} onClick={() => void refreshList()}>
          <RefreshCw size={16} aria-hidden="true" />
        </button>
        <button type="button" className="issue-icon-button" aria-label="프로젝트 간 차단 닫기" onClick={onClose} disabled={saving}>
          <X size={17} aria-hidden="true" />
        </button>
      </div>
    </header>
    {draft && <form id={`${formHeading}-form`} className="gantt-team-blockers-form" aria-labelledby={formHeading} onSubmit={event => void save(event)}>
      <h3 id={formHeading}>프로젝트 간 차단 관계 추가</h3>
      <fieldset disabled={disabled}>
        <IssuePicker label="차단하는 업무" searchLabel="원인 업무 검색" searchRef={sourceSearch}
          selectedId={draft.sourceId} query={draft.sourceQuery} excludedProjectId={target?.projectId}
          issues={activeIssues} issueAliases={data.issueAliases} projectNames={projectNames} onSelect={sourceId => changeDraft({ sourceId })}
          onQuery={sourceQuery => changeDraft({ sourceQuery })} />
        <IssuePicker label="차단되는 업무" searchLabel="차단 대상 업무 검색"
          selectedId={draft.targetId} query={draft.targetQuery} excludedProjectId={source?.projectId}
          issues={activeIssues} issueAliases={data.issueAliases} projectNames={projectNames} onSelect={targetId => changeDraft({ targetId })}
          onQuery={targetQuery => changeDraft({ targetQuery })} />
      </fieldset>
      {invalidPair && <p role="status">서로 다른 프로젝트의 업무를 선택해 주세요.</p>}
      {unavailable && <p role="status">현재 진행 가능한 업무를 선택해 주세요.</p>}
      {duplicate && <p role="status">이미 같은 방향의 차단 관계가 있습니다.</p>}
      {saveError && <p role="alert">{saveError}</p>}
      <div className="gantt-team-blockers-actions">
        <button type="submit" className="btn btn-primary" disabled={disabled || loading || refreshing || !source || !target || invalidPair || duplicate}>
          {saving ? '차단 관계 저장 중' : '차단 관계 저장'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={cancelDraft} disabled={disabled}>차단 관계 입력 취소</button>
      </div>
    </form>}
    {(loading || refreshing) && <p className="gantt-team-blockers-status" role="status">차단 관계를 불러오는 중입니다.</p>}
    {loadError && <p className="gantt-team-blockers-status" role="alert">차단 관계를 불러오지 못했습니다. {loadError}</p>}
    {rows.length > 0 ? <>
      <ul className="gantt-team-blockers-list" role="list" aria-label="프로젝트 간 차단 관계 목록">
        {pageRows.map(({ relation, source, target }, index) => {
          const choices = reviewChoices.get(source.id);
          const showTogether = choices && choices.length > 1 && pageRows.findIndex(row => row.source.id === source.id) === index;
          return <li key={relation.id} data-team-blocker-id={relation.id}>
            <BlockerEndpoint issue={source} project={projectNames.get(source.projectId)} label="차단하는 업무"
              disabled={disabled} openIssue={openIssue} onLocateIssueDate={onLocateIssueDate} onPointerDown={onPointerDown} />
            <ArrowRight className="gantt-team-blockers-arrow" size={16} aria-hidden="true" />
            <BlockerEndpoint issue={target} project={projectNames.get(target.projectId)} label="차단되는 업무"
              disabled={disabled} openIssue={openIssue} onLocateIssueDate={onLocateIssueDate} onPointerDown={onPointerDown} />
            <div className="gantt-team-blockers-actions gantt-team-blockers-review">
              <button type="button" className="btn" aria-haspopup="dialog"
                aria-label={`${source.key} → ${target.key} 프로젝트 간 일정 검토`} disabled={disabled || refreshing}
                aria-describedby={relation.origin === 'jira' ? `${heading}-${relation.id}-origin` : undefined}
                data-gantt-focus-control="" onPointerDown={onPointerDown}
                onClick={event => onReviewSchedule(relation, source, target, event.currentTarget)}>
                <CalendarDays size={15} aria-hidden="true" />프로젝트 간 일정 검토
              </button>
              {showTogether && <button type="button" className="btn" aria-haspopup="dialog"
                aria-label={`${source.key} 후행 일정 함께 검토`} disabled={disabled || refreshing}
                data-gantt-focus-control="" data-team-follow-up-source={source.id} onPointerDown={onPointerDown}
                onClick={event => onReviewTogether(source, choices, event.currentTarget)}>후행 일정 함께 검토</button>}
              {relation.origin === 'jira' && <small id={`${heading}-${relation.id}-origin`}>Jira 이관 관계</small>}
            </div>
          </li>;
        })}
      </ul>
      {lastPage > 0 && <nav className="gantt-team-blockers-actions gantt-team-blockers-pages" aria-label="차단 관계 페이지">
        <span aria-live="polite">{offset + 1}–{Math.min(offset + ROWS_PER_PAGE, rows.length)} / {rows.length}</span>
        <button type="button" className="issue-icon-button" aria-label="차단 관계 이전 페이지" disabled={currentPage === 0}
          onClick={() => setPage(currentPage - 1)}><ArrowLeft size={16} aria-hidden="true" /></button>
        <button type="button" className="issue-icon-button" aria-label="차단 관계 다음 페이지" disabled={currentPage === lastPage}
          onClick={() => setPage(currentPage + 1)}><ArrowRight size={16} aria-hidden="true" /></button>
      </nav>}
    </> : !loading && !refreshing && !loadError && <p className="gantt-team-blockers-status" role="status">현재 보기에 활성 차단 관계가 없습니다.</p>}
  </section>;
}

function IssuePicker({ label, searchLabel, searchRef, selectedId, query, excludedProjectId, issues, issueAliases, projectNames, onSelect, onQuery }: {
  label: string;
  searchLabel: string;
  searchRef?: React.Ref<HTMLInputElement>;
  selectedId: string;
  query: string;
  excludedProjectId?: string;
  issues: readonly Issue[];
  issueAliases?: WorkspaceSnapshot['issueAliases'];
  projectNames: ReadonlyMap<string, string>;
  onSelect: (value: string) => void;
  onQuery: (value: string) => void;
}) {
  const selected = issues.find(issue => issue.id === selectedId);
  const matches = searchIssueCandidates({ issueAliases },
    issues.filter(issue => issue.id === selectedId || issue.projectId !== excludedProjectId), query,
    issue => `${issue.key} ${issue.title} ${projectNames.get(issue.projectId) ?? ''}`);
  const available = matches.filter(({ issue }) => issue.id !== selectedId);
  const selectedMatch = selected && (matches.find(({ issue }) => issue.id === selectedId) ?? { issue: selected, matchedAliases: [] });
  const shown = selectedMatch ? [selectedMatch, ...available.slice(0, ISSUE_MATCH_LIMIT - 1)] : available.slice(0, ISSUE_MATCH_LIMIT);
  return <div className="gantt-team-blockers-picker">
    <label>{searchLabel}<input ref={searchRef} className="field" type="search" value={query} onChange={event => onQuery(event.target.value)} /></label>
    <label>{label}<select className="field" value={selectedId} onChange={event => onSelect(event.target.value)} required>
      <option value="">업무 선택</option>
      {selectedId && !selected && <option value={selectedId} disabled>현재 선택할 수 없는 업무</option>}
      {shown.map(({ issue, matchedAliases }) => <option key={issue.id} value={issue.id}>
        {issue.key} · {issue.title} · {projectNames.get(issue.projectId)}
        {matchedAliases.length > 0 && ` · ${matchedAliases.map(issueSearchAliasLabel).join(' · ')}`}
      </option>)}
    </select></label>
    {available.length > ISSUE_MATCH_LIMIT - Number(Boolean(selected)) && <small>업무 키, 이전 키, 제목 또는 프로젝트 이름으로 검색하세요.</small>}
  </div>;
}

function BlockerEndpoint({ issue, project, label, disabled, openIssue, onLocateIssueDate, onPointerDown }: {
  issue: Issue;
  project: string | undefined;
  label: string;
  disabled: boolean;
} & Pick<Props, 'openIssue' | 'onLocateIssueDate' | 'onPointerDown'>) {
  const endpoint = issue.startDate && !issue.endDate ? 'endDate' : 'startDate';
  return <div className="gantt-team-blockers-endpoint">
    <small>{label} · {project}</small>
    <div className="gantt-team-blockers-actions">
      <button type="button" className="btn btn-ghost gantt-team-blockers-issue" aria-label={`${issue.key} 업무 열기`}
        title={issue.title} disabled={disabled} data-gantt-focus-control="" onPointerDown={onPointerDown}
        onClick={() => openIssue(issue.id)}><strong>{issue.key}</strong> {issue.title}</button>
      <button type="button" className="issue-icon-button" aria-label={`${issue.key} 간트 날짜로 이동`} disabled={disabled}
        data-gantt-focus-control="" onPointerDown={onPointerDown} onClick={() => onLocateIssueDate(issue.id, endpoint)}>
        <CalendarDays size={15} aria-hidden="true" />
      </button>
    </div>
  </div>;
}
