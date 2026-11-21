'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link2, Pencil, Plus, RefreshCw, SquareChartGantt, Unlink2 } from 'lucide-react';
import { issueRelationScheduleMode, type IssueRelationScheduleMode } from '../../shared/issue-relations';
import type { FeatureProps, Issue, IssueRelation, IssueRelationDirection, IssueRelationType } from '../../shared/types';
import { api, ApiError, patch, post, remove } from '../lib/api';
import './issue-relations.css';

const CHOICES = {
  related: { type: 'related', direction: 'outgoing', label: '관련 업무' },
  blocks: { type: 'blocks', direction: 'outgoing', label: '이 업무가 차단함' },
  'blocked-by': { type: 'blocks', direction: 'incoming', label: '이 업무가 차단됨' },
  duplicates: { type: 'duplicates', direction: 'outgoing', label: '이 업무가 중복임' },
  'duplicated-by': { type: 'duplicates', direction: 'incoming', label: '이 업무가 원본임' },
} satisfies Record<string, { type: IssueRelationType; direction: IssueRelationDirection; label: string }>;
const PAGE_SIZE = 50;
const MATCH_LIMIT = 50;
const dateFormat = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium' });

type Choice = keyof typeof CHOICES;
type Draft = { original?: IssueRelation; otherIssueId: string; choice: Choice; query: string };
type Props = Pick<FeatureProps, 'data' | 'openIssue' | 'refresh' | 'notify'> & {
  issueId: string;
  refreshKey: number;
  disabled: boolean;
  onReviewSchedule: (opener: HTMLButtonElement, relation: IssueRelation, mode: IssueRelationScheduleMode, reload: () => Promise<void>) => void;
  onDraftChange: (dirty: boolean, pending: boolean, discard: () => void) => void;
};

function choiceFor(relation: IssueRelation, issueId: string): Choice {
  const outgoing = relation.sourceIssueId === issueId;
  if (relation.type === 'blocks') return outgoing ? 'blocks' : 'blocked-by';
  if (relation.type === 'duplicates') return outgoing ? 'duplicates' : 'duplicated-by';
  return 'related';
}

function otherId(relation: IssueRelation, issueId: string) {
  return relation.sourceIssueId === issueId ? relation.targetIssueId : relation.sourceIssueId;
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : '업무 관계를 처리하지 못했습니다.';
}

function lastOffset(count: number) {
  return Math.max(0, Math.floor((count - 1) / PAGE_SIZE) * PAGE_SIZE);
}

export function IssueRelations(props: Props) {
  return <RelationList key={props.issueId} {...props} />;
}

function RelationList({ issueId, refreshKey, data, openIssue, refresh, notify, disabled, onReviewSchedule, onDraftChange }: Props) {
  const editHeading = useId(), removeHeading = useId();
  const [relations, setRelations] = useState<IssueRelation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [unlinkTarget, setUnlinkTarget] = useState<IssueRelation | null>(null);
  const getRequest = useRef<AbortController | null>(null);
  const pendingRef = useRef(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const otherSelect = useRef<HTMLSelectElement>(null);
  const typeSelect = useRef<HTMLSelectElement>(null);
  const cancelUnlink = useRef<HTMLButtonElement>(null);

  const path = `/issues/${encodeURIComponent(issueId)}/relations`;
  const issueById = useMemo(() => new Map(data.issues.map(issue => [issue.id, issue])), [data.issues]);
  const currentIssue = issueById.get(issueId);
  const projectNames = useMemo(() => new Map(data.projects.map(project => [project.id, project.name])), [data.projects]);
  const otherIssues = useMemo(() => data.issues.filter(issue => issue.id !== issueId), [data.issues, issueId]);
  const scheduledIssueIds = useMemo(() => new Set(data.dependencies.flatMap(dependency => {
    if (dependency.predecessorId === issueId) return [dependency.successorId];
    if (dependency.successorId === issueId) return [dependency.predecessorId];
    return [];
  })), [data.dependencies, issueId]);
  const terms = draft?.query.trim().toLocaleLowerCase().split(/\s+/u) ?? [];
  const matches = draft && !draft.original
    ? otherIssues.filter(issue => {
      const item = `${issue.key} ${issue.title}`.toLocaleLowerCase();
      return terms.every(term => item.includes(term));
    }) : [];
  const shownMatches = matches.slice(0, MATCH_LIMIT);
  const selectedIssue = draft && issueById.get(draft.otherIssueId);
  const activeOffset = Math.min(offset, lastOffset(relations.length));
  const captured = draft?.original ?? unlinkTarget;
  const current = captured && relations.find(relation => relation.id === captured.id);
  const stale = Boolean(captured && (!current || current.version !== captured.version));
  const edited = Boolean(draft && (draft.original ? draft.choice !== choiceFor(draft.original, issueId)
    : draft.otherIssueId || draft.query.trim() || draft.choice !== 'related'));

  const load = useCallback(async () => {
    getRequest.current?.abort();
    const request = new AbortController();
    getRequest.current = request;
    setLoading(true);
    try {
      const rows = await api<IssueRelation[]>(path, { signal: request.signal });
      if (!request.signal.aborted) {
        setRelations(rows);
        setOffset(previous => Math.min(previous, lastOffset(rows.length)));
        setLoadError('');
      }
    } catch (cause) {
      if (!request.signal.aborted) setLoadError(errorMessage(cause));
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    const reload = () => { if (!pendingRef.current) void load(); };
    const timer = setTimeout(reload, 0);
    window.addEventListener('teamspace:trash-changed', reload);
    window.addEventListener('teamspace:workspace-imported', reload);
    return () => {
      clearTimeout(timer);
      getRequest.current?.abort();
      window.removeEventListener('teamspace:trash-changed', reload);
      window.removeEventListener('teamspace:workspace-imported', reload);
    };
  }, [load]);

  const lastRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (lastRefreshKey.current === refreshKey || busy) return;
    const timer = setTimeout(() => {
      if (pendingRef.current) return;
      lastRefreshKey.current = refreshKey;
      void load();
    }, 0);
    return () => clearTimeout(timer);
  }, [refreshKey, busy, load]);

  const discard = useCallback(() => {
    setDraft(null);
    setUnlinkTarget(null);
    setActionError('');
  }, []);

  useLayoutEffect(() => {
    onDraftChange(edited, busy, discard);
    return () => onDraftChange(false, false, discard);
  }, [edited, busy, discard, onDraftChange]);

  useLayoutEffect(() => {
    const target = returnFocus.current;
    if (!target || busy || disabled || draft || unlinkTarget) return;
    returnFocus.current = null;
    (target.isConnected && !target.disabled ? target : addButton.current)?.focus({ preventScroll: true });
  }, [busy, disabled, draft, unlinkTarget]);

  function closeAction() {
    returnFocus.current = opener.current ?? addButton.current;
    opener.current = null;
    discard();
  }

  function editRelation(button: HTMLButtonElement, original?: IssueRelation) {
    opener.current = button;
    setActionError('');
    setUnlinkTarget(null);
    setDraft({ original, otherIssueId: original ? otherId(original, issueId) : '', choice: original ? choiceFor(original, issueId) : 'related', query: '' });
    requestAnimationFrame(() => (original ? typeSelect : searchInput).current?.focus());
  }

  function confirmUnlink(button: HTMLButtonElement, target: IssueRelation) {
    opener.current = button;
    setDraft(null);
    setActionError('');
    setUnlinkTarget(target);
    requestAnimationFrame(() => cancelUnlink.current?.focus());
  }

  async function mutate(commit: () => Promise<void>) {
    if (pendingRef.current || disabled) return;
    pendingRef.current = true;
    setBusy(true);
    setActionError('');
    getRequest.current?.abort();
    setLoading(false);
    try {
      await commit();
    } catch (cause) {
      setActionError(errorMessage(cause));
      if (cause instanceof ApiError && (cause.status === 404 || cause.status === 409)) await load();
    } finally {
      pendingRef.current = false;
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !selectedIssue || !edited || stale) return;
    const { type, direction } = CHOICES[draft.choice];
    const original = draft.original;
    void mutate(async () => {
      const row = original
        ? await patch<IssueRelation>(`${path}/${encodeURIComponent(original.id)}`, { expectedVersion: original.version, type, direction })
        : await post<IssueRelation>(path, { otherIssueId: draft.otherIssueId, type, direction });
      const index = relations.findIndex(relation => relation.id === row.id);
      if (index < 0) setRelations(previous => [...previous, row]);
      else setRelations(previous => previous.map(relation => relation.id === row.id ? row : relation));
      setOffset(lastOffset(index === -1 ? relations.length + 1 : index + 1));
      closeAction();
      notify(original ? '업무 관계를 수정했습니다.' : '업무 관계를 저장했습니다.');
      void load();
      void refresh().catch(() => undefined);
    });
  }

  function unlink() {
    if (!unlinkTarget || stale) return;
    const { id, version } = unlinkTarget;
    void mutate(async () => {
      await remove(`${path}/${encodeURIComponent(id)}?expectedVersion=${version}`);
      setRelations(previous => previous.filter(relation => relation.id !== id));
      setOffset(Math.min(offset, lastOffset(relations.length - 1)));
      closeAction();
      notify('업무 관계를 해제했습니다.');
      void load();
      void refresh().catch(() => undefined);
    });
  }

  const controlsDisabled = disabled || busy;
  const actionsOpen = Boolean(draft || unlinkTarget);
  const targetName = unlinkTarget && issueById.get(otherId(unlinkTarget, issueId))?.key;
  const staleMessage = '다른 작업자가 업무 관계를 변경했습니다. 최신 관계를 열어 확인해 주세요.';
  function optionLabel(issue: Issue) {
    return `${issue.key} · ${issue.title} · ${projectNames.get(issue.projectId) ?? '프로젝트 없음'}`;
  }

  return <section className="issue-related-section issue-relations" aria-label="업무 관계">
    <header className="issue-relations-header">
      <h3><Link2 size={16} aria-hidden="true" />업무 관계 <span>{relations.length}</span></h3>
      <div className="issue-relations-actions">
        <button className="btn btn-ghost" type="button" aria-label="업무 관계 새로고침"
          disabled={controlsDisabled || loading} onClick={() => void load()}><RefreshCw size={14} aria-hidden="true" />새로고침</button>
        <button ref={addButton} className="btn" type="button" disabled={controlsDisabled || actionsOpen || !otherIssues.length}
          onClick={event => editRelation(event.currentTarget)}><Plus size={14} aria-hidden="true" />업무 관계 추가</button>
      </div>
    </header>
    {loadError && <p className="issue-form-error" role="alert">{loadError}</p>}
    {!relations.length && !loadError && <p className="issue-section-empty" role={loading ? 'status' : undefined}>
      {loading ? '업무 관계를 불러오는 중…' : '연결된 업무 관계가 없습니다.'}
    </p>}
    {draft && <form className="issue-relations-editor" aria-labelledby={editHeading} aria-busy={busy} onSubmit={submit}
      onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); if (!busy) closeAction(); } }}>
      <h4 id={editHeading}>{draft.original ? '업무 관계 수정' : '업무 관계 추가'}</h4>
      {draft.original ? <p className="issue-relations-fixed">{selectedIssue ? optionLabel(selectedIssue) : '현재 목록에 없는 업무'}</p> : <>
        <label className="issue-form-label">연결할 업무 검색
          <input className="field" ref={searchInput} type="search" value={draft.query} disabled={controlsDisabled}
            placeholder="업무 번호 또는 제목" onChange={event => setDraft({ ...draft, query: event.target.value })}
            onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); otherSelect.current?.focus(); } }} />
        </label>
        <label className="issue-form-label">연결할 업무
          <select className="field" ref={otherSelect} value={draft.otherIssueId} disabled={controlsDisabled} required
            onChange={event => setDraft({ ...draft, otherIssueId: event.target.value })}>
            <option value="">{matches.length ? '업무 선택' : '조건에 맞는 업무 없음'}</option>
            {selectedIssue && !shownMatches.some(issue => issue.id === selectedIssue.id) && <option value={selectedIssue.id}>{optionLabel(selectedIssue)}</option>}
            {shownMatches.map(issue => <option key={issue.id} value={issue.id}>{optionLabel(issue)}</option>)}
          </select>
        </label>
        {matches.length > MATCH_LIMIT && <p className="issue-relations-hint">검색 결과 {matches.length}개 중 {MATCH_LIMIT}개를 표시합니다. 검색어로 범위를 좁히세요.</p>}
      </>}
      <label className="issue-form-label">업무 관계 유형
        <select className="field" ref={typeSelect} value={draft.choice} disabled={controlsDisabled}
          onChange={event => setDraft({ ...draft, choice: event.target.value as Choice })}>
          {Object.entries(CHOICES).map(([key, choice]) => <option key={key} value={key}>{choice.label}</option>)}
        </select>
      </label>
      {(stale || actionError) && <p className="issue-form-error" role="alert">{stale ? staleMessage : actionError}</p>}
      <footer className="issue-relations-actions">
        <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => closeAction()}>취소</button>
        {stale && current && <button className="btn" type="button" disabled={controlsDisabled}
          onClick={() => { if (opener.current) editRelation(opener.current, current); }}>최신 관계 열기</button>}
        <button className="btn btn-primary" type="submit" disabled={controlsDisabled || stale || !selectedIssue || !edited}>관계 저장</button>
      </footer>
    </form>}
    {unlinkTarget && <div className="issue-relations-editor" role="group" aria-labelledby={removeHeading}
      onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); if (!busy) closeAction(); } }}>
      <h4 id={removeHeading}>업무 관계 해제</h4>
      <p className="issue-relations-hint">{targetName ? `${targetName} 업무와의 관계를 해제합니다.` : '선택한 업무 관계를 해제합니다.'}</p>
      {(actionError || stale) && <p className="issue-form-error" role="alert">{stale ? staleMessage : actionError}</p>}
      <footer className="issue-relations-actions">
        <button ref={cancelUnlink} className="btn btn-ghost" type="button" disabled={busy} onClick={() => closeAction()}>취소</button>
        <button className="btn issue-btn-danger" type="button" disabled={controlsDisabled || stale} onClick={unlink}>업무 관계 해제</button>
      </footer>
    </div>}
    {!!relations.length && <ul className="issue-relations-list">
      {relations.slice(activeOffset, activeOffset + PAGE_SIZE).map((relation, index) => {
        const targetId = otherId(relation, issueId);
        const other = issueById.get(targetId);
        const scheduleMode = currentIssue && other && other.id !== issueId && currentIssue.projectId === other.projectId
          ? issueRelationScheduleMode(relation) : null;
        const local = relation.origin === 'teamspace';
        const label = local ? CHOICES[choiceFor(relation, issueId)].label : relation.type;
        const labelId = `${editHeading}-${activeOffset + index}`;
        const created = new Date(relation.createdAt);
        return <li className="issue-relations-row" key={relation.id}>
          <div className="issue-relations-label">
            <strong id={labelId}>{label}</strong>
            {!local && <small>이관 관계 · {relation.sourceIssueId === issueId ? '이 업무가 출발' : '이 업무가 도착'}</small>}
            {Number.isFinite(created.getTime()) && <time dateTime={relation.createdAt}>{dateFormat.format(created)}</time>}
          </div>
          {other ? <button className="btn btn-ghost issue-relations-target" type="button" onClick={() => openIssue(targetId)}>
            <span><strong>{other.key}</strong> · {other.title}</span><small>{projectNames.get(other.projectId)}</small>
          </button> : <span className="issue-relations-hint">현재 목록에 없는 업무 · {targetId}</span>}
          {local && other && <div className="issue-relations-row-actions">
            <button className="issue-icon-button" type="button" aria-label={`${other.key} 관계 수정`} aria-describedby={labelId} title="관계 수정"
              disabled={controlsDisabled || actionsOpen} onClick={event => editRelation(event.currentTarget, relation)}><Pencil size={15} aria-hidden="true" /></button>
            <button className="issue-icon-button" type="button" aria-label={`${other.key} 관계 해제`} aria-describedby={labelId} title="관계 해제"
              disabled={controlsDisabled || actionsOpen} onClick={event => confirmUnlink(event.currentTarget, relation)}><Unlink2 size={15} aria-hidden="true" /></button>
          </div>}
          {scheduleMode && other && <div className="issue-relations-schedule">
            {scheduledIssueIds.has(other.id) ? <span>일정 연결됨</span> :
              <button className="btn btn-ghost" type="button" aria-label={`${other.key} 일정 연결 검토`} aria-describedby={labelId}
                disabled={controlsDisabled || actionsOpen || loading}
                onClick={event => onReviewSchedule(event.currentTarget, relation, scheduleMode, load)}>
                <SquareChartGantt size={14} aria-hidden="true" />일정 연결 검토
              </button>}
          </div>}
        </li>;
      })}
    </ul>}
    {relations.length > PAGE_SIZE && <div className="issue-relations-actions issue-relations-pager">
      <span>{activeOffset + 1}–{Math.min(activeOffset + PAGE_SIZE, relations.length)} / {relations.length}</span>
      <button className="btn btn-ghost" type="button" disabled={!activeOffset || actionsOpen} onClick={() => setOffset(activeOffset - PAGE_SIZE)}>관계 이전 페이지</button>
      <button className="btn btn-ghost" type="button" disabled={activeOffset + PAGE_SIZE >= relations.length || actionsOpen} onClick={() => setOffset(activeOffset + PAGE_SIZE)}>관계 다음 페이지</button>
    </div>}
  </section>;
}
