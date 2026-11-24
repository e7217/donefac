'use client';

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type Ref } from 'react';
import { ArrowRightLeft, Link2, X } from 'lucide-react';
import type { IssueRelationScheduleMode } from '../../shared/issue-relations';
import type { Dependency, DependencyType, Issue, Project, SchedulePasteApplyResult, SchedulePastePreview, WorkspaceSnapshot } from '../../shared/types';
import { DEPENDENCY_ENDPOINTS, DEPENDENCY_LABELS, DEPENDENCY_TYPES, isDependencyLag, isDependencyType, MAX_DEPENDENCY_LAG_DAYS, SCHEDULE_DATE_LABELS } from '../../shared/schedule-dependencies';
import { issueSearchAliasLabel, searchIssueCandidates } from '../../shared/workspace-search';
import { ApiError } from '../lib/api';
import { isUncertainScheduleResponse } from './schedule-undo';
import { errorMessage } from './schedule-utils';
import './issue-schedule-relations.css';

export type DependencyInput = Pick<Dependency, 'predecessorId' | 'successorId' | 'type' | 'lagDays'>;
export type DependencyPrefill = { predecessorId: string; successorId: string; type?: DependencyType };
export type RelatedIssueDirection = 'predecessor' | 'successor';
export type DependencyRelationReview = { sourceIssueId: string; targetIssueId: string; mode: IssueRelationScheduleMode };

type ScheduleReview = {
  preview: (input: DependencyInput, rescheduleSuccessors: boolean, includeTeamBlockers: boolean) => Promise<SchedulePastePreview>;
  apply: (previewId: string) => Promise<SchedulePasteApplyResult>;
  reflect: (result: SchedulePasteApplyResult) => Promise<void>;
  revision?: string;
  currentDependency?: Dependency;
  projects?: readonly Pick<Project, 'id' | 'name'>[];
  remove?: boolean;
};
type Props = {
  issues: Issue[];
  issueAliases?: WorkspaceSnapshot['issueAliases'];
  dependency?: Dependency;
  prefill?: DependencyPrefill;
  anchor?: { issueId: string; otherRole: RelatedIssueDirection };
  relationReview?: DependencyRelationReview;
  staleMessage?: string;
  onClose: (awaitingResult?: boolean) => void;
  busy: boolean;
  onDraftChange: (id: string, dirty: boolean, pending?: boolean, awaitingResult?: boolean) => void;
} & (
  | { onSubmit: (input: DependencyInput) => Promise<void>; scheduleReview?: never }
  | { scheduleReview: ScheduleReview; onSubmit?: never }
);
type Reviewed = { result: SchedulePastePreview; inputVersion: string };
type Pending = 'preview' | 'apply' | 'recover' | 'reflect';
const pendingLabels: Record<Pending, string> = {
  preview: '업무 연결과 일정을 확인하는 중입니다.',
  apply: '검토한 연결을 적용하는 중입니다.',
  recover: '적용 결과를 확인하는 중입니다.',
  reflect: '간트에 적용 결과를 반영하는 중입니다.',
};
const currentTime = () => Date.now();

function relationIssueText(issue: Issue | undefined) {
  return issue ? `${issue.key} · ${issue.title}` : '업무를 찾을 수 없습니다.';
}

export function GanttDependencyModal({ issues, issueAliases, dependency, prefill, anchor, relationReview, staleMessage, onClose, onSubmit, busy, onDraftChange, scheduleReview }: Props) {
  const id = useId();
  const fixedRelation = relationReview?.mode === 'fixed-direction' ? relationReview : undefined;
  const initialPredecessor = relationReview ? (fixedRelation?.sourceIssueId ?? '') :
    dependency?.predecessorId ?? prefill?.predecessorId ?? (anchor?.otherRole === 'successor' ? anchor.issueId : '');
  const initialSuccessor = relationReview ? (fixedRelation?.targetIssueId ?? '') :
    dependency?.successorId ?? prefill?.successorId ?? (anchor?.otherRole === 'predecessor' ? anchor.issueId : '');
  const initialType = (dependency ? dependency.type : prefill?.type) ?? 'FS';
  const initialLag = String(dependency?.lagDays ?? 0);
  const [draftPredecessorId, setPredecessorId] = useState(initialPredecessor);
  const [draftSuccessorId, setSuccessorId] = useState(initialSuccessor);
  const [directionDraft, setDirectionDraft] = useState<Pick<DependencyInput, 'predecessorId' | 'successorId'>>();
  const [typeDraft, setType] = useState<DependencyType | undefined>(prefill?.type);
  const [lagDraft, setLag] = useState<string>();
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [rescheduleSuccessors, setRescheduleSuccessors] = useState(false);
  const [includeTeamBlockers, setIncludeTeamBlockers] = useState(false);
  const [review, setReview] = useState<Reviewed | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [retryId, setRetryId] = useState<string | null>(null);
  const [applied, setApplied] = useState<SchedulePasteApplyResult | null>(null);
  const [clock, setClock] = useState(currentTime);
  const mounted = useRef(true);
  const requestActive = useRef(false);
  const dialog = useRef<HTMLElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const predecessorSelect = useRef<HTMLSelectElement>(null);
  const relationDirectionSelect = useRef<HTMLSelectElement>(null);
  const typeSelect = useRef<HTMLSelectElement>(null);
  const previewButton = useRef<HTMLButtonElement>(null);
  const recoveryButton = useRef<HTMLButtonElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const errorNotice = useRef<HTMLDivElement>(null);
  const focusAfterRequest = useRef<'review' | 'recovery' | 'error' | null>(null);
  const editing = Boolean(dependency);
  const removing = Boolean(scheduleReview?.remove);
  const reviewingSelection = Boolean(dependency || prefill || relationReview);
  const chooseRelationDirection = relationReview?.mode === 'choose-direction';
  const currentDependency = scheduleReview?.currentDependency;
  const currentPredecessorId = currentDependency?.predecessorId ?? initialPredecessor;
  const currentSuccessorId = currentDependency?.successorId ?? initialSuccessor;
  const currentType = currentDependency?.type ?? initialType;
  const currentLag = currentDependency ? String(currentDependency.lagDays) : initialLag;
  const predecessorId = directionDraft?.predecessorId ?? currentDependency?.predecessorId ?? draftPredecessorId;
  const successorId = directionDraft?.successorId ?? currentDependency?.successorId ?? draftSuccessorId;
  const type = typeDraft ?? currentType;
  const lag = lagDraft ?? currentLag;
  const edited = predecessorId !== currentPredecessorId || successorId !== currentSuccessorId || type !== currentType || lag !== currentLag;
  const dirty = !applied && Boolean(edited || rescheduleSuccessors || review || retryId);
  const lagDays = lag.trim() === '' ? NaN : Number(lag);
  const endpoints = DEPENDENCY_ENDPOINTS[type];
  const predecessor = issues.find(issue => issue.id === predecessorId);
  const successor = issues.find(issue => issue.id === successorId);
  const ready = Boolean(predecessor && successor && predecessor.id !== successor.id && predecessor.projectId === successor.projectId && isDependencyLag(lagDays));
  const running = busy || Boolean(pending);
  const editLocked = running || Boolean(retryId || applied);
  const failure = retryId || applied ? error : staleMessage || error;
  const canSubmit = ready && !editLocked && !staleMessage && (!editing || edited || removing);
  const inputVersion = JSON.stringify([predecessorId, predecessor?.version, predecessor?.projectId,
    successorId, successor?.version, successor?.projectId, type, lag, rescheduleSuccessors, includeTeamBlockers, scheduleReview?.revision]);
  const expires = review?.result.expiresAt ? Date.parse(review.result.expiresAt) : NaN;
  const reviewStale = Boolean(review && (review.inputVersion !== inputVersion || staleMessage || expires <= clock));
  const applyId = canSubmit && !reviewStale && Number.isFinite(expires) && review?.result.previewId && !review.result.errors.length &&
    (review.result.dependencyChanges?.length || review.result.changes.length) ? review.result.previewId : null;
  const relationSource = relationReview && issues.find(issue => issue.id === relationReview.sourceIssueId);
  const relationTarget = relationReview && issues.find(issue => issue.id === relationReview.targetIssueId);
  const relationDirection = predecessorId === relationReview?.sourceIssueId ? 'source-first' : predecessorId === relationReview?.targetIssueId ? 'target-first' : '';
  const anchoredIssue = anchor && issues.find(issue => issue.id === anchor.issueId);
  const otherIsSuccessor = Boolean(anchor && predecessorId === anchor.issueId);
  const otherIssueId = otherIsSuccessor ? successorId : predecessorId;
  const otherIssue = otherIsSuccessor ? successor : predecessor;
  const searchForIssue = Boolean(anchor && !editing && !relationReview);
  const candidates = searchForIssue && anchoredIssue ? searchIssueCandidates({ issueAliases },
    issues.filter(issue => issue.id !== anchoredIssue.id && issue.projectId === anchoredIssue.projectId), query) : [];
  useEffect(() => {
    const focus = removing ? previewButton : chooseRelationDirection ? relationDirectionSelect : searchForIssue ? searchInput
      : reviewingSelection ? typeSelect : predecessorSelect;
    const target = focus.current?.matches(':enabled') ? focus.current : dialog.current;
    target?.focus({ preventScroll: true });
  }, [chooseRelationDirection, removing, reviewingSelection, searchForIssue]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!review?.result.previewId || !Number.isFinite(expires)) return;
    const timer = window.setTimeout(() => setClock(currentTime()), Math.max(0, expires - currentTime() + 1));
    return () => window.clearTimeout(timer);
  }, [expires, review?.result.previewId]);
  useEffect(() => {
    if (running) {
      dialog.current?.focus({ preventScroll: true });
      return;
    }
    const target = focusAfterRequest.current;
    focusAfterRequest.current = null;
    if (target === 'review') reviewHeading.current?.focus();
    if (target === 'recovery') recoveryButton.current?.focus();
    if (target === 'error') errorNotice.current?.focus();
  }, [applied, error, retryId, review, running]);
  useEffect(() => {
    onDraftChange('dependency', dirty, running, Boolean(retryId));
    return () => onDraftChange('dependency', false);
  }, [onDraftChange, dirty, retryId, running]);

  function close() {
    if (running || requestActive.current) return;
    if (scheduleReview) onClose(Boolean(retryId));
    else onClose();
  }

  function handleKeys(event: KeyboardEvent<HTMLElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
    if (event.key !== 'Tab') return;
    const focusable = event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not(:disabled), select:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex^="-"])',
    );
    const first = focusable[0], last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (!first || (event.shiftKey ? active === first || active === event.currentTarget : active === last)) {
      event.preventDefault();
      const target = (event.shiftKey ? last : first) ?? event.currentTarget;
      target.focus();
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit || requestActive.current) return;
    const input = { predecessorId, successorId, type, lagDays };
    if (scheduleReview) {
      await runReviewRequest('preview', async () => {
        setReview(null);
        try {
          const result = await scheduleReview.preview(input, rescheduleSuccessors, includeTeamBlockers);
          if (!mounted.current) return;
          setReview({ result, inputVersion });
          setClock(currentTime());
          focusAfterRequest.current = 'review';
        } catch (cause) {
          if (!mounted.current) return;
          setError(`${errorMessage(cause)} 입력을 유지했습니다. 연결 미리보기를 다시 만들어 주세요.`);
          focusAfterRequest.current = 'error';
        }
      });
      return;
    }
    setError('');
    try {
      await onSubmit(input);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function runReviewRequest(kind: Pending, run: () => Promise<void>) {
    if (requestActive.current) return;
    requestActive.current = true;
    setPending(kind);
    setError('');
    try { await run(); }
    finally {
      requestActive.current = false;
      if (mounted.current) setPending(null);
    }
  }

  async function reflect(result: SchedulePasteApplyResult) {
    try { await scheduleReview?.reflect(result); }
    catch (cause) {
      if (!mounted.current) return;
      setError(`${errorMessage(cause)} 연결은 적용되었습니다. 간트에 다시 반영할 수 있습니다.`);
      focusAfterRequest.current = 'recovery';
    }
  }

  async function applyReview() {
    if (!scheduleReview || running || applied) return;
    const previewId = retryId ?? applyId;
    const now = currentTime();
    if (!previewId || (!retryId && now >= expires)) {
      setClock(now);
      return;
    }
    await runReviewRequest(retryId ? 'recover' : 'apply', async () => {
      try {
        const result = await scheduleReview.apply(previewId);
        if (!mounted.current) return;
        if (!result || typeof result.undoId !== 'string' || !result.undoId || !Array.isArray(result.updated) || !Array.isArray(result.warnings)) {
          throw new Error('연결 적용 응답을 확인할 수 없습니다.');
        }
        setRetryId(null);
        setApplied(result);
        await reflect(result);
      } catch (cause) {
        if (!mounted.current) return;
        const authRejection = cause instanceof ApiError && (cause.status === 401 || cause.status === 403);
        const uncertain = isUncertainScheduleResponse(cause) || Boolean(retryId && authRejection);
        setRetryId(uncertain ? previewId : null);
        if (!uncertain) setReview(null);
        setError(uncertain
          ? '적용 여부를 확인하지 못했습니다. 같은 요청으로 적용 결과를 다시 확인해 주세요.'
          : `${errorMessage(cause)} 연결 입력을 유지했습니다. 연결 미리보기를 다시 만들어 주세요.`);
        focusAfterRequest.current = uncertain ? 'recovery' : 'error';
      }
    });
  }

  function swapDirection() {
    if (editing && scheduleReview) {
      setDirectionDraft(successorId === currentPredecessorId && predecessorId === currentSuccessorId
        ? undefined : { predecessorId: successorId, successorId: predecessorId });
      return;
    }
    setPredecessorId(successorId);
    setSuccessorId(predecessorId);
  }

  function pickRelationDirection(direction: string) {
    if (!relationReview) return;
    const { sourceIssueId, targetIssueId } = relationReview;
    switch (direction) {
      case 'source-first':
        setPredecessorId(sourceIssueId);
        setSuccessorId(targetIssueId);
        break;
      case 'target-first':
        setPredecessorId(targetIssueId);
        setSuccessorId(sourceIssueId);
        break;
      default:
        setPredecessorId('');
        setSuccessorId('');
    }
  }

  return <div className="issue-modal-overlay">
    <section ref={dialog} className="gantt-link-modal" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1} onKeyDown={handleKeys}>
      <form onSubmit={submit}>
        <header>
          <h2 id={`${id}-title`}>{removing ? '업무 연결 해제' : relationReview ? '관계에서 일정 연결' : editing ? '업무 연결 수정' : '선행·후행 업무 연결'}</h2>
          <button className="issue-icon-button" type="button" disabled={running} onClick={close} aria-label="업무 연결 닫기"><X size={20} /></button>
        </header>
        <div className="gantt-link-fields">
          {removing ? <>
            <div className="issue-dependent-context"><span>선행 업무</span><strong>{relationIssueText(predecessor)}</strong></div>
            <div className="issue-dependent-context"><span>후행 업무</span><strong>{relationIssueText(successor)}</strong></div>
          </> : relationReview ? <>
            {chooseRelationDirection && <label className="issue-form-label issue-dependent-search">일정 연결 방향
              <select ref={relationDirectionSelect} className="field" aria-label="일정 연결 방향" value={relationDirection}
                disabled={editLocked || !relationSource || !relationTarget} required onChange={event => pickRelationDirection(event.target.value)}>
                <option value="">선행 업무를 선택하세요</option>
                <option value="source-first">{relationSource?.key ?? '목록에 없는 업무'} 선행 → {relationTarget?.key ?? '목록에 없는 업무'} 후행</option>
                <option value="target-first">{relationTarget?.key ?? '목록에 없는 업무'} 선행 → {relationSource?.key ?? '목록에 없는 업무'} 후행</option>
              </select>
            </label>}
            {relationDirection ? <>
              <div className="issue-dependent-context"><span>선행 업무</span><strong>{relationIssueText(predecessor)}</strong></div>
              <div className="issue-dependent-context"><span>후행 업무</span><strong>{relationIssueText(successor)}</strong></div>
            </> : <div className="issue-dependent-context issue-dependent-search">
              <span>관계에 연결된 업무</span><strong>{relationIssueText(relationSource)}</strong><strong>{relationIssueText(relationTarget)}</strong>
            </div>}
            <p className="gantt-link-help">간트에서 저장한 연결을 확인하고 시작일과 종료일을 조정할 수 있습니다.</p>
          </> : anchor ? <>
            <div className="issue-dependent-context"><span>현재 업무</span><strong>{anchoredIssue?.key} · {anchoredIssue?.title}</strong></div>
            <label className="issue-form-label">연결 방향
              <select className="field" aria-label="연결 방향" value={otherIsSuccessor ? 'successor' : 'predecessor'} disabled={editLocked} onChange={event => {
                if ((event.target.value === 'successor') === otherIsSuccessor) return;
                swapDirection();
              }}>
                <option value="predecessor">상대 업무가 선행</option>
                <option value="successor">상대 업무가 후행</option>
              </select>
            </label>
            {editing ? <div className="issue-dependent-context"><span>상대 업무</span><strong>{otherIssue?.key} · {otherIssue?.title}</strong></div> : <>
              <label className="issue-form-label issue-dependent-search">연결할 업무 검색
                <input ref={searchInput} className="field" type="search" aria-label="연결할 업무 검색" placeholder="업무 키, 이전 키 또는 제목" value={query} disabled={editLocked}
                  onChange={event => setQuery(event.target.value)} onKeyDown={event => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.preventDefault();
                  }} />
              </label>
              <label className="issue-form-label">연결할 업무
                <select className="field" aria-label="연결할 업무" value={otherIssueId} disabled={editLocked} required onChange={event => {
                  (otherIsSuccessor ? setSuccessorId : setPredecessorId)(event.target.value);
                }}>
                  <option value="">{candidates.length ? '업무 선택' : '조건에 맞는 업무 없음'}</option>
                  {otherIssue && !candidates.some(({ issue }) => issue.id === otherIssue.id) && <option value={otherIssue.id}>{relationIssueText(otherIssue)}</option>}
                  {candidates.map(({ issue, matchedAliases }) => <option key={issue.id} value={issue.id}>
                    {relationIssueText(issue)}{matchedAliases.length > 0 && ` · ${matchedAliases.map(issueSearchAliasLabel).join(' · ')}`}
                  </option>)}
                </select>
              </label>
            </>}
          </> : <>
            <label className="issue-form-label">선행 업무
              <select ref={predecessorSelect} className="field" aria-label="선행 업무" disabled={editLocked || editing} value={predecessorId} onChange={event => setPredecessorId(event.target.value)} required>
                <option value="">선행 업무 선택</option>
                {issues.filter(issue => issue.id !== successorId && (!successor || issue.projectId === successor.projectId)).map(issue => (
                  <option key={issue.id} value={issue.id}>{issue.key} · {issue.title}</option>
                ))}
              </select>
            </label>
            <label className="issue-form-label">후행 업무
              <select className="field" aria-label="후행 업무" disabled={editLocked || editing} value={successorId} onChange={event => setSuccessorId(event.target.value)} required>
                <option value="">후행 업무 선택</option>
                {issues.filter(issue => issue.id !== predecessorId && (!predecessor || issue.projectId === predecessor.projectId)).map(issue => (
                  <option key={issue.id} value={issue.id}>{issue.key} · {issue.title}</option>
                ))}
              </select>
            </label>
            {editing && <div className="issue-dependent-search">
              <button className="btn" type="button" disabled={editLocked || !predecessor || !successor} onClick={swapDirection}>
                <ArrowRightLeft size={15} aria-hidden="true" />선행·후행 바꾸기
              </button>
              <span className="sr-only" role="status">선행 {predecessor?.key} → 후행 {successor?.key}</span>
            </div>}
          </>}
          {!removing && <>
            <label className="issue-form-label">연결 유형
              <select ref={typeSelect} className="field" aria-label="연결 유형" disabled={editLocked} value={type} aria-describedby={`${id}-type-help`} onChange={event => {
                if (isDependencyType(event.target.value)) setType(event.target.value);
              }}>
                {DEPENDENCY_TYPES.map(value => <option key={value} value={value}>{DEPENDENCY_LABELS[value]} ({value})</option>)}
              </select>
            </label>
            <label className="issue-form-label">추가 간격 (근무일)
              <input className="field" aria-label="추가 간격 근무일" aria-describedby={`${id}-lag-help`} disabled={editLocked} type="number" inputMode="text" value={lag} onChange={event => setLag(event.target.value)} min={-MAX_DEPENDENCY_LAG_DAYS} max={MAX_DEPENDENCY_LAG_DAYS} required step="1" />
            </label>
            <p id={`${id}-type-help`} className="gantt-link-help">
              {type === 'FS' ? '선행 업무 종료 후 첫 근무일부터 후행 업무의 시작일을 계산합니다.'
                : `선행 업무의 ${SCHEDULE_DATE_LABELS[endpoints.predecessor]}을 기준으로 후행 업무의 ${SCHEDULE_DATE_LABELS[endpoints.successor]}을 계산합니다.`}
            </p>
            <p id={`${id}-lag-help`} className="gantt-link-help">양수는 늦추고 음수는 앞당깁니다. 일정 미리보기와 자동 일정 제안에 프로젝트 근무일을 적용합니다.</p>
          </>}
          {scheduleReview && !removing && <label className="gantt-link-follow-up">
            <input type="checkbox" checked={rescheduleSuccessors} disabled={editLocked}
              onChange={event => {
                setRescheduleSuccessors(event.currentTarget.checked);
                if (!event.currentTarget.checked) setIncludeTeamBlockers(false);
              }} />후행 일정 함께 검토
          </label>}
          {rescheduleSuccessors && !removing && (scheduleReview?.projects?.length ?? 0) > 1 && <label className="gantt-link-follow-up">
            <input type="checkbox" checked={includeTeamBlockers} disabled={editLocked}
              onChange={event => setIncludeTeamBlockers(event.currentTarget.checked)} />프로젝트 간 차단 포함
          </label>}
          {pending && <p className="gantt-link-help" role="status">{pendingLabels[pending]}</p>}
          {!running && failure &&
            <div ref={errorNotice} className="issue-form-error" role="alert" tabIndex={-1}>{failure}</div>}
        </div>
        {review && <DependencyReviewResult key={review.result.previewId ?? review.inputVersion}
          result={review.result} projects={scheduleReview?.projects} headingRef={reviewHeading} stale={reviewStale && !retryId && !applied} />}
        <footer>
          <button className="btn btn-ghost" type="button" disabled={running} onClick={close}>{applied ? '닫기' : '취소'}</button>
          {scheduleReview ? applied ? <button ref={recoveryButton} className="btn btn-primary" type="button"
            disabled={running} onClick={() => void runReviewRequest('reflect', () => reflect(applied))}>화면 반영 다시 시도</button>
            : retryId ? <button ref={recoveryButton} className="btn btn-primary" type="button" disabled={running}
              onClick={() => void applyReview()}>적용 결과 다시 확인</button> : <>
                <button ref={previewButton} className={applyId ? 'btn' : 'btn btn-primary'} type="submit" disabled={!canSubmit}>
                  <Link2 size={15} />연결 미리보기
                </button>
                <button className={applyId ? 'btn btn-primary' : 'btn'} type="button" disabled={!applyId}
                  onClick={() => void applyReview()}>검토한 연결 적용</button>
              </> : <button className="btn btn-primary" type="submit" disabled={!canSubmit}>
                <Link2 size={15} />{busy ? '저장 중…' : editing ? '연결 변경 저장' : '업무 연결'}
              </button>}
        </footer>
      </form>
    </section>
  </div>;
}

function DependencyReviewResult({ result, projects, headingRef, stale }: {
  result: SchedulePastePreview;
  projects?: ScheduleReview['projects'];
  headingRef: Ref<HTMLHeadingElement>;
  stale: boolean;
}) {
  const headingId = useId();
  const followUps = new Set(result.followUpIssueIds);
  const projectNames = new Map(projects?.filter(project => project.id !== result.projectId).map(project => [project.id, project.name]));
  const warnings = [...new Set([...result.warnings, ...(result.teamBlockerWarnings ?? [])])];
  return <section className="gantt-link-review" aria-labelledby={headingId}>
    <h3 id={headingId} ref={headingRef} tabIndex={-1}>업무 연결 미리보기</h3>
    {stale && <p role="status">검토 조건이 변경되었거나 미리보기가 만료되었습니다. 연결 미리보기를 다시 만들어 주세요.</p>}
    {result.dependencyChanges?.map(change => {
      const direction = `${change.predecessorKey} → ${change.successorKey}`;
      const before = change.beforeDirection
        ? `${change.beforeDirection.predecessorKey} → ${change.beforeDirection.successorKey}` : direction;
      return <dl key={change.line} className="gantt-link-direction-review">
        <div><dt>변경 전</dt><dd>{change.before ? `${before} · ${change.before.type} · ${change.before.lagDays}근무일` : '연결 없음'}</dd></div>
        <div><dt>변경 후</dt><dd>{change.after ? `${direction} · ${change.after.type} · ${change.after.lagDays}근무일` : '연결 없음'}</dd></div>
      </dl>;
    })}
    {result.changes.length > 0 && <>
      <h4>일정 변경 {result.changes.length}건</h4>
      <ul className="gantt-link-review-list" aria-label="후행 일정 변경 목록" tabIndex={0}>
        {result.changes.map(change => <li key={change.id}>
          <strong>{change.key} · {change.title}</strong>
          {change.projectId && projectNames.has(change.projectId) && <small>{projectNames.get(change.projectId)}</small>}
          {followUps.has(change.id) && <small>후행 조정</small>}
          <span>시작일 {change.fromStart ?? '미정'} → {change.toStart ?? '미정'}</span>
          <span>종료일 {change.fromEnd ?? '미정'} → {change.toEnd ?? '미정'}</span>
        </li>)}
      </ul>
    </>}
    {result.errors.length > 0 && <ul className="issue-form-error gantt-link-review-messages" aria-label="연결 오류" role="alert">
      {result.errors.map(({ key, message }, index) => <li key={index}>{key ? `${key} · ${message}` : message}</li>)}
    </ul>}
    {warnings.length > 0 && <ul className="gantt-link-review-messages gantt-link-review-warnings" aria-label="일정 경고">
      {warnings.map(warning => <li key={warning}>{warning}</li>)}
    </ul>}
    {!result.changes.length && !result.errors.length && <p>{result.dependencyChanges?.length ? '변경되는 일정이 없습니다.' : '변경할 연결이 없습니다.'}</p>}
  </section>;
}
