'use client';

import { useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type Ref } from 'react';
import { Link2, Pencil, Plus, RefreshCw, SquareChartGantt, Unlink2 } from 'lucide-react';
import { issueRelationScheduleMode, type IssueRelationScheduleMode } from '../../shared/issue-relations';
import type { FeatureProps, Issue, IssueCloseAsDuplicateInput, IssueCloseAsDuplicateResult, IssueRelation, IssueRelationDirection, IssueRelationType, IssueRelationView, WorkspaceSnapshot } from '../../shared/types';
import { allowedNextStatuses, isTerminalStatus, projectWorkflow, statusMeta } from '../../shared/workflow-helpers';
import { issueSearchAliasLabel, searchIssueCandidates } from '../../shared/workspace-search';
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
type TargetDraft = { otherIssueId: string; query: string };
type Draft = TargetDraft & { original?: IssueRelation; choice: Choice };
type DuplicateDraft = TargetDraft & Omit<IssueCloseAsDuplicateInput, 'originalIssueId' | 'expectedOriginalVersion'> & {
  expectedOriginalVersion: number | null;
};
export interface IssueRelationsHandle { focusBlockers: () => void }
type Props = Pick<FeatureProps, 'data' | 'openIssue' | 'refresh' | 'notify'> & {
  issue: Issue;
  refreshKey: number;
  disabled: boolean;
  duplicateCloseDisabled?: boolean;
  hasUnsavedStatus?: boolean;
  highlightOpenBlockers: boolean;
  controlsRef: Ref<IssueRelationsHandle>;
  onDuplicateClosed: (updated: Issue, observed?: boolean) => void;
  onCreateBlockedIssue: (opener: HTMLButtonElement) => void;
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
  return <RelationList key={props.issue.id} {...props} />;
}

function RelationList({
  issue: currentIssue, refreshKey, data, openIssue, refresh, notify, disabled, duplicateCloseDisabled, hasUnsavedStatus,
  highlightOpenBlockers, controlsRef, onReviewSchedule, onDraftChange, onDuplicateClosed, onCreateBlockedIssue,
}: Props) {
  const { id: issueId } = currentIssue;
  const editHeading = useId(), removeHeading = useId(), duplicateHeading = useId();
  const [relations, setRelations] = useState<IssueRelationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [duplicateDraft, setDuplicateDraft] = useState<DuplicateDraft | null>(null);
  const [duplicateNeedsReview, setDuplicateNeedsReview] = useState(false);
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
  const section = useRef<HTMLElement>(null);

  const path = `/issues/${encodeURIComponent(issueId)}/relations`;
  const issueById = useMemo(() => new Map(data.issues.map(issue => [issue.id, issue])), [data.issues]);
  const projectsById = useMemo(() => new Map(data.projects.map(project => [project.id, project])), [data.projects]);
  const otherIssues = useMemo(() => data.issues.filter(issue => issue.id !== issueId), [data.issues, issueId]);
  const scheduledIssueIds = useMemo(() => new Set(data.dependencies.flatMap(dependency => {
    if (dependency.predecessorId === issueId) return [dependency.successorId];
    if (dependency.successorId === issueId) return [dependency.predecessorId];
    return [];
  })), [data.dependencies, issueId]);
  const targetDraft = duplicateDraft ?? (draft && !draft.original ? draft : null);
  const matches = targetDraft ? searchIssueCandidates(data, otherIssues, targetDraft.query, issue => {
    const project = projectsById.get(issue.projectId);
    return `${issue.title} ${project?.name ?? ''} ${project?.key ?? ''}`;
  }) : [];
  const shownMatches = matches.slice(0, MATCH_LIMIT);
  const selectedIssue = issueById.get((duplicateDraft ?? draft)?.otherIssueId ?? '');
  const originals = relations.filter(row => row.origin === 'teamspace' && row.type === 'duplicates' && row.sourceIssueId === issueId);
  const existingOriginal = originals.length === 1 ? issueById.get(originals[0].targetIssueId) : undefined;
  const activeOffset = Math.min(offset, lastOffset(relations.length));
  const { workflows, issueSchemas } = data;
  const workflowVersion = projectWorkflow(data, currentIssue.projectId).version;
  const duplicateStatuses = isTerminalStatus(data, currentIssue.projectId, currentIssue.status) ? [] :
    allowedNextStatuses(data, currentIssue).filter(status => status.category === 'cancelled' || status.category === 'done')
      .sort((left, right) => Number(left.category === 'done') - Number(right.category === 'done'));
  const defaultDuplicateStatus = duplicateStatuses[0]?.id ?? '';
  const duplicateStale = Boolean(duplicateDraft && (
    duplicateDraft.expectedVersion !== currentIssue.version || duplicateDraft.expectedWorkflowVersion !== workflowVersion ||
    duplicateDraft.otherIssueId && duplicateDraft.expectedOriginalVersion !== selectedIssue?.version
  ));
  const openBlockerStatuses = useMemo(() => {
    const statuses = new Map<string, string>();
    if (!highlightOpenBlockers) return statuses;
    for (const relation of relations) {
      const incoming = relation.origin === 'teamspace' && relation.type === 'blocks' && relation.targetIssueId === issueId ||
        relation.verifiedBlockerDirection === 'incoming';
      if (!incoming) continue;
      const source = issueById.get(otherId(relation, issueId));
      if (!source || source.id === issueId) continue;
      const status = statusMeta({ workflows, issueSchemas }, source.projectId, source.status);
      if (status.category !== 'done' && status.category !== 'cancelled') statuses.set(relation.id, status.label);
    }
    return statuses;
  }, [highlightOpenBlockers, relations, issueById, issueId, workflows, issueSchemas]);
  const displayRelations = useMemo(() => openBlockerStatuses.size === 0 ? relations : [
    ...relations.filter(relation => openBlockerStatuses.has(relation.id)),
    ...relations.filter(relation => !openBlockerStatuses.has(relation.id)),
  ], [openBlockerStatuses, relations]);
  const captured = draft?.original ?? unlinkTarget;
  const current = captured && relations.find(relation => relation.id === captured.id);
  const stale = Boolean(captured && (!current || current.version !== captured.version));
  const edited = Boolean(draft && (draft.original ? draft.choice !== choiceFor(draft.original, issueId)
    : draft.otherIssueId || draft.query.trim() || draft.choice !== 'related')) || Boolean(duplicateDraft &&
      (duplicateDraft.otherIssueId !== (existingOriginal?.id ?? '') || duplicateDraft.query.trim() || duplicateDraft.status !== defaultDuplicateStatus));

  useImperativeHandle(controlsRef, () => ({ focusBlockers() {
    setOffset(0);
    section.current?.focus({ preventScroll: true });
    section.current?.scrollIntoView({ block: 'start' });
  } }), []);

  const load = useCallback(async () => {
    getRequest.current?.abort();
    const request = new AbortController();
    getRequest.current = request;
    setLoading(true);
    try {
      const rows = await api<IssueRelationView[]>(path, { signal: request.signal });
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
    setDuplicateDraft(null);
    setDuplicateNeedsReview(false);
    setUnlinkTarget(null);
    setActionError('');
  }, []);

  useLayoutEffect(() => {
    onDraftChange(edited, busy, discard);
    return () => onDraftChange(false, false, discard);
  }, [edited, busy, discard, onDraftChange]);

  useLayoutEffect(() => {
    const target = returnFocus.current;
    if (!target || busy || disabled || draft || duplicateDraft || unlinkTarget) return;
    returnFocus.current = null;
    (target.isConnected && !target.disabled ? target : addButton.current)?.focus({ preventScroll: true });
  }, [busy, disabled, draft, duplicateDraft, unlinkTarget]);

  function closeAction(focusTarget = opener.current ?? addButton.current) {
    returnFocus.current = focusTarget;
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

  function editDuplicate(button: HTMLButtonElement) {
    opener.current = button;
    setActionError('');
    setDuplicateNeedsReview(false);
    setDuplicateDraft({
      otherIssueId: existingOriginal?.id ?? '', query: '', status: defaultDuplicateStatus,
      expectedVersion: currentIssue.version, expectedOriginalVersion: existingOriginal?.version ?? null, expectedWorkflowVersion: workflowVersion,
    });
    requestAnimationFrame(() => searchInput.current?.focus());
  }

  function confirmUnlink(button: HTMLButtonElement, target: IssueRelation) {
    opener.current = button;
    setDraft(null);
    setActionError('');
    setUnlinkTarget(target);
    requestAnimationFrame(() => cancelUnlink.current?.focus());
  }

  async function mutate(commit: () => Promise<void>, onError?: (cause: unknown) => Promise<void>) {
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
      if (onError) await onError(cause);
      else if (cause instanceof ApiError && (cause.status === 404 || cause.status === 409)) await load();
    } finally {
      pendingRef.current = false;
      setBusy(false);
    }
  }

  function reflectRelation(row: IssueRelation) {
    const index = relations.findIndex(relation => relation.id === row.id);
    if (index < 0) setRelations(previous => [...previous, row]);
    else setRelations(previous => previous.map(relation => relation.id === row.id ? row : relation));
    setOffset(lastOffset(index === -1 ? relations.length + 1 : index + 1));
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
      reflectRelation(row);
      closeAction();
      notify(original ? '업무 관계를 수정했습니다.' : '업무 관계를 저장했습니다.');
      void load();
      void refresh().catch(() => undefined);
    });
  }

  function duplicateClosed({ issue, relation }: IssueCloseAsDuplicateResult, observed = false) {
    reflectRelation(relation);
    closeAction(addButton.current);
    onDuplicateClosed(issue, observed);
    notify(observed ? '최신 업무에서 종료 상태와 원본 연결을 확인했습니다.' : '원본 업무와 연결하고 중복으로 닫았습니다.');
    void load();
    void refresh().catch(() => undefined);
  }

  const duplicateStatusValid = duplicateStatuses.some(status => status.id === duplicateDraft?.status);
  const canCloseDuplicate = !duplicateCloseDisabled && !duplicateNeedsReview && !duplicateStale &&
    duplicateStatusValid && Boolean(selectedIssue && duplicateDraft?.expectedOriginalVersion != null);

  function submitDuplicate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!duplicateDraft || !canCloseDuplicate || duplicateDraft.expectedOriginalVersion === null) return;
    const { status, expectedVersion, expectedOriginalVersion, expectedWorkflowVersion, otherIssueId } = duplicateDraft;
    const input: IssueCloseAsDuplicateInput = { originalIssueId: otherIssueId, status, expectedVersion, expectedOriginalVersion, expectedWorkflowVersion };
    void mutate(async () => {
      const result = await post<IssueCloseAsDuplicateResult>(`/issues/${encodeURIComponent(issueId)}/close-as-duplicate`, input);
      duplicateClosed(result);
    }, async cause => {
      if (cause instanceof ApiError && (cause.status === 404 || cause.status === 409)) {
        setDuplicateNeedsReview(true);
        await Promise.allSettled([load(), refresh()]);
      } else if (!(cause instanceof ApiError) || cause.status >= 500 || [408, 425, 429, 499].includes(cause.status)) {
        setDuplicateNeedsReview(true);
        setActionError('중복 처리 결과를 확인하지 못했습니다. 최신 정보를 확인해 주세요.');
      }
    });
  }

  function reviewDuplicate() {
    if (!duplicateDraft) return;
    const captured = duplicateDraft;
    void mutate(async () => {
      const [snapshot, rows] = await Promise.all([
        api<WorkspaceSnapshot>('/workspace', { cache: 'no-store' }),
        api<IssueRelationView[]>(path, { cache: 'no-store' }),
      ]);
      const latestIssue = snapshot.issues.find(issue => issue.id === issueId);
      const latestOriginal = snapshot.issues.find(issue => issue.id === captured.otherIssueId);
      if (!latestIssue) throw new Error('닫을 업무의 최신 정보를 찾을 수 없습니다.');
      const matchingRelation = rows.find(row => row.origin === 'teamspace' && row.type === 'duplicates' &&
        row.sourceIssueId === issueId && row.targetIssueId === captured.otherIssueId);
      if (latestIssue.status === captured.status && latestIssue.version > captured.expectedVersion && matchingRelation) {
        duplicateClosed({ issue: latestIssue, relation: matchingRelation }, true);
        return;
      }
      await refresh();
      setRelations(rows);
      setOffset(previous => Math.min(previous, lastOffset(rows.length)));
      setLoadError('');
      setDuplicateDraft({ ...captured, expectedVersion: latestIssue.version, expectedOriginalVersion: latestOriginal?.version ?? null,
        expectedWorkflowVersion: projectWorkflow(snapshot, latestIssue.projectId).version });
      setDuplicateNeedsReview(false);
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
  const actionsOpen = Boolean(draft || duplicateDraft || unlinkTarget);
  const targetName = unlinkTarget && issueById.get(otherId(unlinkTarget, issueId))?.key;
  const staleMessage = '다른 작업자가 업무 관계를 변경했습니다. 최신 관계를 열어 확인해 주세요.';
  function optionLabel(issue: Issue) {
    return `${issue.key} · ${issue.title} · ${projectsById.get(issue.projectId)?.name ?? '프로젝트 없음'}`;
  }

  function targetPicker(target: TargetDraft, searchLabel: string, selectLabel: string, update: (changes: Partial<TargetDraft>) => void) {
    return <>
      <label className="issue-form-label">{searchLabel}
        <input className="field" ref={searchInput} type="search" value={target.query} disabled={controlsDisabled}
          placeholder="업무 키, 이전 키, 제목 또는 프로젝트" onChange={event => update({ query: event.target.value })}
          onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); otherSelect.current?.focus(); } }} />
      </label>
      <label className="issue-form-label">{selectLabel}
        <select className="field" ref={otherSelect} value={target.otherIssueId} disabled={controlsDisabled} required
          onChange={event => update({ otherIssueId: event.target.value })}>
          <option value="">{matches.length ? '업무 선택' : '조건에 맞는 업무 없음'}</option>
          {shownMatches.map(({ issue, matchedAliases }) => <option key={issue.id} value={issue.id}>
            {optionLabel(issue)}{matchedAliases.length > 0 && ` · ${matchedAliases.map(issueSearchAliasLabel).join(' · ')}`}
          </option>)}
          {selectedIssue && !shownMatches.some(({ issue }) => issue.id === selectedIssue.id) && <option value={selectedIssue.id}>{optionLabel(selectedIssue)}</option>}
          {target.otherIssueId && !selectedIssue && <option value={target.otherIssueId} disabled>현재 목록에 없는 업무</option>}
        </select>
      </label>
      {matches.length > MATCH_LIMIT && <p className="issue-relations-hint">검색 결과 {matches.length}개 중 {MATCH_LIMIT}개를 표시합니다. 검색어로 범위를 좁히세요.</p>}
    </>;
  }

  return <section ref={section} className="issue-related-section issue-relations" aria-label="업무 관계" tabIndex={-1}>
    <header className="issue-relations-header">
      <h3><Link2 size={16} aria-hidden="true" />업무 관계 <span>{relations.length}</span></h3>
      <div className="issue-relations-actions">
        <button className="btn btn-ghost" type="button" aria-label="업무 관계 새로고침"
          disabled={controlsDisabled || loading} onClick={() => void load()}><RefreshCw size={14} aria-hidden="true" />새로고침</button>
        <button ref={addButton} className="btn" type="button" disabled={controlsDisabled || actionsOpen || !otherIssues.length}
          onClick={event => editRelation(event.currentTarget)}><Plus size={14} aria-hidden="true" />업무 관계 추가</button>
        {data.projects.some(project => project.id !== currentIssue.projectId) && <button className="btn" type="button"
          aria-haspopup="dialog" disabled={controlsDisabled || actionsOpen}
          onClick={event => onCreateBlockedIssue(event.currentTarget)}><Plus size={14} aria-hidden="true" />새 차단 대상 업무</button>}
        <button className="btn" type="button" disabled={controlsDisabled || duplicateCloseDisabled || actionsOpen || loading || !otherIssues.length || !duplicateStatuses.length}
          title={duplicateStatuses.length ? undefined : '이 업무에서 이동할 수 있는 종료 상태가 없습니다.'}
          onClick={event => editDuplicate(event.currentTarget)}>중복으로 닫기</button>
      </div>
    </header>
    {loadError && <p className="issue-form-error" role="alert">{loadError}</p>}
    {!relations.length && !loadError && <p className="issue-section-empty" role={loading ? 'status' : undefined}>
      {loading ? '업무 관계를 불러오는 중…' : '연결된 업무 관계가 없습니다.'}
    </p>}
    {draft && <form className="issue-relations-editor" aria-labelledby={editHeading} aria-busy={busy} onSubmit={submit}
      onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); if (!busy) closeAction(); } }}>
      <h4 id={editHeading}>{draft.original ? '업무 관계 수정' : '업무 관계 추가'}</h4>
      {draft.original ? <p className="issue-relations-fixed">{selectedIssue ? optionLabel(selectedIssue) : '현재 목록에 없는 업무'}</p>
        : targetPicker(draft, '연결할 업무 검색', '연결할 업무', changes => setDraft({ ...draft, ...changes }))}
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
    {duplicateDraft && <form className="issue-relations-editor" aria-labelledby={duplicateHeading} aria-busy={busy} onSubmit={submitDuplicate}
      onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); if (!busy) closeAction(); } }}>
      <h4 id={duplicateHeading}>중복으로 닫기</h4>
      <p className="issue-relations-hint">{currentIssue.key} 업무를 원본 업무에 연결하고 선택한 상태로 닫습니다.</p>
      {targetPicker(duplicateDraft, '원본 업무 검색', '원본 업무', changes => setDuplicateDraft({
        ...duplicateDraft, ...changes,
        expectedOriginalVersion: changes.otherIssueId === undefined ? duplicateDraft.expectedOriginalVersion : issueById.get(changes.otherIssueId)?.version ?? null,
      }))}
      <label className="issue-form-label">닫을 상태
        <select className="field" value={duplicateDraft.status} disabled={controlsDisabled} required
          onChange={event => setDuplicateDraft({ ...duplicateDraft, status: event.target.value })}>
          {duplicateDraft.status && !duplicateStatusValid && <option value={duplicateDraft.status} disabled>이전 선택 상태를 사용할 수 없음</option>}
          {duplicateStatuses.map(status => <option key={status.id} value={status.id}>{status.label}</option>)}
        </select>
      </label>
      {hasUnsavedStatus && <p className="issue-relations-hint">업무 상세에서 저장하지 않은 상태는 여기에서 선택한 상태로 바뀝니다.</p>}
      {duplicateCloseDisabled && <p className="issue-relations-hint">업무 상세의 최신 버전을 확인한 뒤 적용해 주세요.</p>}
      {(actionError || duplicateStale) && <p className="issue-form-error" role="alert">
        {actionError || '닫을 업무, 원본 업무 또는 워크플로가 바뀌었습니다. 최신 정보를 확인해 주세요.'}
      </p>}
      <footer className="issue-relations-actions">
        <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => closeAction()}>취소</button>
        {(duplicateNeedsReview || duplicateStale) && <button className="btn" type="button" disabled={controlsDisabled}
          onClick={reviewDuplicate}>최신 정보 확인</button>}
        <button className="btn btn-primary" type="submit" disabled={controlsDisabled || !canCloseDuplicate}>중복으로 닫기 적용</button>
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
      {displayRelations.slice(activeOffset, activeOffset + PAGE_SIZE).map((relation, index) => {
        const targetId = otherId(relation, issueId);
        const other = issueById.get(targetId);
        const scheduleMode = currentIssue && other && other.id !== issueId && currentIssue.projectId === other.projectId
          ? issueRelationScheduleMode(relation) : null;
        const local = relation.origin === 'teamspace';
        const label = local ? CHOICES[choiceFor(relation, issueId)].label : relation.type;
        const labelId = `${editHeading}-${activeOffset + index}`;
        const created = new Date(relation.createdAt);
        const blockerStatus = openBlockerStatuses.get(relation.id);
        return <li className="issue-relations-row" key={relation.id} data-open-blocker={blockerStatus !== undefined ? '' : undefined}>
          <div className="issue-relations-label">
            <strong id={labelId}>{label}</strong>
            {blockerStatus !== undefined && <small className="issue-relations-open-blocker"><strong>열린 차단 업무</strong><span> · {blockerStatus}</span></small>}
            {!local && <small>{relation.verifiedBlockerDirection
              ? `Jira 이관 관계 · ${relation.verifiedBlockerDirection === 'incoming' ? '이 업무가 차단됨' : '이 업무가 차단함'}`
              : `이관 관계 · ${relation.sourceIssueId === issueId ? '이 업무가 출발' : '이 업무가 도착'}`}</small>}
            {Number.isFinite(created.getTime()) && <time dateTime={relation.createdAt}>{dateFormat.format(created)}</time>}
          </div>
          {other ? <button className="btn btn-ghost issue-relations-target" type="button"
            aria-label={blockerStatus !== undefined ? `${other.key} 업무 열기` : undefined} onClick={() => openIssue(targetId)}>
            <span><strong>{other.key}</strong> · {other.title}</span><small>{projectsById.get(other.projectId)?.name}</small>
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
