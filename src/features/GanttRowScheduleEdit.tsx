'use client';

import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { CalendarRange, Check, Loader2, Plus, RefreshCw, X } from 'lucide-react';
import { CalendarError, createCalendarMath, defaultWorkCalendar, isCalendarDate, MAX_CALENDAR_DATE, MAX_WORKING_DURATION_DAYS } from '../../shared/calendar';
import {
  DEPENDENCY_LABELS, DEPENDENCY_TYPES, dependencyBound, dependencyGuardFields, isDependencyLag,
  MAX_DEPENDENCY_LAG_DAYS, SCHEDULE_DATE_LABELS,
} from '../../shared/schedule-dependencies';
import { suggestMissingScheduleDates, type MissingScheduleLink } from '../../shared/schedule-missing-dates';
import {
  MAX_SCHEDULE_ROW_DEPENDENCY_EDITS,
  type Dependency, type DependencyType, type FeatureProps, type Issue, type ScheduleBulkDateChanges,
  type SchedulePasteApplyResult, type SchedulePastePreview, type ScheduleRowDependencyEdit, type ScheduleRowEditInput,
  type ScheduleUndoScope, type WorkCalendar, type WorkspaceSnapshot,
} from '../../shared/types';
import { issueSearchAliasLabel, searchIssueCandidates } from '../../shared/workspace-search';
import { ApiError, api } from '../lib/api';
import { scheduleUndoHeaders } from './schedule-undo';
import { errorMessage, todayDate } from './schedule-utils';
import type { TeamIncomingBlocker } from './team-follow-up-choices';
import { WorkingDayRangePicker } from './WorkingDayRangePicker';
import './schedule-paste.css';
import './gantt-row-schedule-edit.css';

type Props = Pick<FeatureProps, 'actorId' | 'notify' | 'refresh'> & {
  issue: Issue;
  issues: readonly Issue[];
  issueAliases?: WorkspaceSnapshot['issueAliases'];
  dependencies: readonly Dependency[];
  incomingTeamBlockers?: readonly TeamIncomingBlocker[];
  calendar?: WorkCalendar;
  focusDate?: 'dueDate';
  initialDates?: ScheduleBulkDateChanges;
  initialDateDraft?: Pick<Issue, 'version' | 'startDate' | 'endDate' | 'dueDate'>;
  undoScope?: ScheduleUndoScope;
  onClose: () => void;
  onDraftChange: (id: string, dirty: boolean, pending?: boolean) => void;
  onApplied: (result: SchedulePasteApplyResult, reviewedAnchorVersion: number) => Promise<void>;
};
type DateField = keyof ScheduleBulkDateChanges;
type LinkAction = 'none' | 'add' | 'update' | 'remove';
type Direction = 'predecessor' | 'successor';
type Pending = 'preview' | 'apply' | 'recover' | 'reload' | 'reflect';
type Review = { input: string; result: SchedulePastePreview; editGroups: number[]; anchorVersion: number };
type AppliedReview = { result: SchedulePasteApplyResult; anchorVersion: number };
type LinkDraft = {
  id: number;
  action: LinkAction;
  direction: Direction;
  query: string;
  relatedId: string;
  dependencyId: string;
  type: DependencyType;
  lag: string;
};
type LinkDraftChanges = Partial<Omit<LinkDraft, 'id'>>;
type ExistingLink = { dependency: Dependency; other: Issue; role: Direction };
type DraftResolution = {
  selected?: ExistingLink;
  related?: Issue;
  edit?: ScheduleRowDependencyEdit;
  target?: string;
  predecessor?: Issue;
  lagDays: number;
  duplicateExisting: boolean;
  valid: boolean;
};

export const GANTT_ROW_SCHEDULE_DRAFT = 'gantt-row-schedule-edit';
const dates = [
  { field: 'startDate', label: '시작일', from: 'fromStart', to: 'toStart' },
  { field: 'endDate', label: '종료일', from: 'fromEnd', to: 'toEnd' },
  { field: 'dueDate', label: '목표 마감일', from: 'fromDue', to: 'toDue' },
] as const;
const scheduleEndpoints = ['startDate', 'endDate'] as const;
const pendingLabels: Record<Pending, string> = {
  preview: '일정과 연결을 검토하는 중입니다.',
  apply: '검토한 변경을 적용하는 중입니다.',
  recover: '이전 적용 요청의 결과를 확인하는 중입니다.',
  reload: '최신 업무와 연결을 불러오는 중입니다.',
  reflect: '적용한 일정을 화면에 반영하는 중입니다.',
};
const issueText = (issue: Issue) => `${issue.key} · ${issue.title}`;
const versionedIssue = (issue: Issue) => ({ id: issue.id, expectedVersion: issue.version });
const ruleText = (rule: Pick<Dependency, 'type' | 'lagDays'> | null) =>
  rule ? `${DEPENDENCY_LABELS[rule.type]} (${rule.type}), ${rule.lagDays}근무일` : '연결 없음';
const hasChanges = (result: SchedulePastePreview) => Boolean(result.changes.length || result.dependencyChanges?.length);
const currentTime = () => Date.now();
const defaultLinkDraft: Omit<LinkDraft, 'id'> = {
  action: 'none', direction: 'predecessor', query: '', relatedId: '', dependencyId: '', type: 'FS', lag: '0',
};
const linkDraft = (id: number): LinkDraft => ({ ...defaultLinkDraft, id });

function resolveDraft(draft: LinkDraft, anchor: Issue, projectIssues: ReadonlyMap<string, Issue>, links: readonly ExistingLink[]): DraftResolution {
  const { action, direction, relatedId, dependencyId, lag, type } = draft;
  const selected = links.find(({ dependency }) => dependency.id === dependencyId);
  const related = projectIssues.get(relatedId);
  const lagDays = lag.trim() ? Number(lag) : NaN;
  const duplicateExisting = action === 'add' && links.some(link => link.other.id === relatedId && link.role === direction);
  const resolution: DraftResolution = { selected, related, lagDays, duplicateExisting, valid: action === 'none' };

  if (action === 'add' && related) {
    resolution.target = JSON.stringify(direction === 'predecessor' ? [related.id, anchor.id] : [anchor.id, related.id]);
    resolution.valid = !duplicateExisting && isDependencyLag(lagDays);
    if (resolution.valid) {
      resolution.edit = { action, relatedIssue: versionedIssue(related), direction, type, lagDays };
      if (direction === 'predecessor') resolution.predecessor = related;
    }
  } else if (selected && (action === 'update' || action === 'remove')) {
    const { dependency } = selected;
    resolution.target = JSON.stringify([dependency.predecessorId, dependency.successorId]);
    resolution.valid = action === 'remove' || isDependencyLag(lagDays);
    const existing = { id: dependency.id, expectedVersion: dependency.version ?? 1, relatedIssue: versionedIssue(selected.other) };
    if (action === 'remove') resolution.edit = { action, ...existing };
    else if (resolution.valid) {
      if (selected.role === 'predecessor') resolution.predecessor = selected.other;
      if (type !== dependency.type || lagDays !== dependency.lagDays) {
        resolution.edit = { action, ...existing, type, lagDays };
      }
    }
  }
  return resolution;
}

function linksForDateSuggestion(links: readonly ExistingLink[], edits: readonly ScheduleRowDependencyEdit[],
  projectIssues: ReadonlyMap<string, Issue>): MissingScheduleLink[] {
  const byId = new Map(links.map(({ dependency: { id, type, lagDays }, role, other }) => [id, { type, lagDays, role, other }]));
  const added: MissingScheduleLink[] = [];
  for (const edit of edits) {
    if (edit.action === 'add') {
      const other = projectIssues.get(edit.relatedIssue.id);
      if (other) added.push({ role: edit.direction, type: edit.type, lagDays: edit.lagDays, other });
    } else if (edit.action === 'remove') byId.delete(edit.id);
    else {
      const link = byId.get(edit.id);
      if (link) byId.set(edit.id, { ...link, type: edit.type, lagDays: edit.lagDays });
    }
  }
  return [...byId.values(), ...added];
}

function definiteRejection(cause: unknown, recovering: boolean) {
  return cause instanceof ApiError && cause.status >= 400 && cause.status < 500 &&
    ![408, 425, 429, 499].includes(cause.status) &&
    (!recovering || (cause.status !== 401 && cause.status !== 403));
}

export function GanttRowScheduleEdit({
  issue, issues, issueAliases, dependencies, incomingTeamBlockers = [], calendar, focusDate, initialDates, initialDateDraft, actorId, undoScope,
  notify, refresh, onClose, onDraftChange, onApplied,
}: Props) {
  const uid = useId();
  const [editedDates, setEditedDates] = useState<ScheduleBulkDateChanges>(() => initialDates ?? {});
  const [suggestionOverrides, setSuggestionOverrides] = useState<ScheduleBulkDateChanges>({});
  const [suggestionDuration, setSuggestionDuration] = useState('3');
  const [drafts, setDrafts] = useState(() => [linkDraft(1)]);
  const [rescheduleSuccessors, setRescheduleSuccessors] = useState(false);
  const nextDraftId = useRef(2);
  const [review, setReview] = useState<Review | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [retryId, setRetryId] = useState<string | null>(null);
  const [applied, setApplied] = useState<AppliedReview | null>(null);
  const [reloadNeeded, setReloadNeeded] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [clock, setClock] = useState(currentTime);
  const modal = useRef<HTMLElement>(null);
  const initialDateInput = useRef<HTMLInputElement>(null);
  const suggestionDurationInput = useRef<HTMLInputElement>(null);
  const previewButton = useRef<HTMLButtonElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const errorNotice = useRef<HTMLParagraphElement>(null);
  const recoverButton = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<'review' | 'error' | 'recover' | null>(null);
  const request = useRef<AbortController | null>(null);
  const dirtyRef = useRef(false);

  const projectIssues = useMemo(() => new Map(issues.filter(value => value.projectId === issue.projectId)
    .map(value => [value.id, value])), [issue.projectId, issues]);
  const currentIssue = projectIssues.get(issue.id);
  const anchor = currentIssue && currentIssue.version >= issue.version ? currentIssue : issue;
  const links = useMemo<ExistingLink[]>(() => dependencies.flatMap(dependency => {
    const role = dependency.predecessorId === issue.id ? 'successor' : dependency.successorId === issue.id ? 'predecessor' : null;
    if (!role) return [];
    const other = projectIssues.get(role === 'successor' ? dependency.successorId : dependency.predecessorId);
    return other ? [{ dependency, other, role }] : [];
  }), [dependencies, issue.id, projectIssues]);
  const editLocked = Boolean(pending || retryId || applied);
  const datesChanged = initialDateDraft === undefined ? Object.keys(editedDates).length > 0
    : dates.some(({ field }) => editedDates[field] !== initialDates?.[field]);
  const dirty = !applied && Boolean(datesChanged || drafts.some(draft => draft.action !== 'none') || review || retryId);

  const changes: ScheduleBulkDateChanges = {};
  const nextDates = { startDate: anchor.startDate, endDate: anchor.endDate, dueDate: anchor.dueDate, ...editedDates };
  const transferredDatesStale = initialDateDraft !== undefined && anchor.version !== initialDateDraft.version;
  for (const { field } of dates) {
    const value = nextDates[field];
    if (value !== anchor[field]) changes[field] = value;
  }

  const resolvedDrafts = drafts.map(draft => resolveDraft(draft, anchor, projectIssues, links));
  const targetCounts = new Map<string, number>();
  const edits: ScheduleRowDependencyEdit[] = [];
  const editGroups: number[] = [];
  for (const [index, { edit, target }] of resolvedDrafts.entries()) {
    if (target) targetCounts.set(target, (targetCounts.get(target) ?? 0) + 1);
    if (edit) { edits.push(edit); editGroups.push(index + 1); }
  }
  const duplicateDraft = ({ target }: DraftResolution) => target !== undefined && (targetCounts.get(target) ?? 0) > 1;
  const suggestionApplied = Object.keys(suggestionOverrides).length > 0;
  const payload: ScheduleRowEditInput = { projectId: issue.projectId, issue: versionedIssue(anchor), changes,
    ...(edits.length === 1 ? { dependency: edits[0] } : edits.length > 1 ? { dependencies: edits } : {}),
    ...(rescheduleSuccessors ? { rescheduleSuccessors } : {}),
    ...(suggestionApplied ? { reviewIncomingTeamBlockers: true } : {}) };
  const input = JSON.stringify({
    payload, editGroups, calendarVersion: calendar?.version ?? 1,
    links: links.map(link => [dependencyGuardFields(link.dependency), link.other.version]),
    incoming: suggestionApplied ? incomingTeamBlockers.map(({ relation, source }) =>
      [relation.id, relation.origin, relation.version, source.id, source.projectId, source.version, source.endDate]) : undefined,
  });
  const linksValid = resolvedDrafts.every(draft => draft.valid && !duplicateDraft(draft));
  const canPreview = Boolean(currentIssue && actorId && linksValid && (Object.keys(changes).length || edits.length) &&
    Object.values(changes).every(value => value === null || isCalendarDate(value)));
  const result = review?.result;
  const expiry = result?.expiresAt ? Date.parse(result.expiresAt) : NaN;
  const reviewStale = review && (input !== review.input || expiry <= clock);
  const applyId = !editLocked && !reloadNeeded && review && !reviewStale && Number.isFinite(expiry) &&
    !review.result.errors.length && hasChanges(review.result) ? review.result.previewId : null;
  function reviewGroup(line: number | null) {
    const group = line === null ? undefined : review?.editGroups[line - 1];
    return drafts.length > 1 && group !== undefined ? `연결 변경 ${group}` : null;
  }

  const calendarMath = useMemo(() => createCalendarMath(calendar ?? defaultWorkCalendar(issue.projectId)), [calendar, issue.projectId]);
  const showMissingDateSuggestion = (!nextDates.startDate || !nextDates.endDate) &&
    (links.length > 0 || incomingTeamBlockers.length > 0 || resolvedDrafts.some(({ edit }) => edit?.action === 'add'));
  const earliestDates: Partial<Record<keyof typeof SCHEDULE_DATE_LABELS, string>> = {};
  for (const [index, resolved] of resolvedDrafts.entries()) {
    if (!resolved.predecessor || duplicateDraft(resolved)) continue;
    try {
      const candidate = dependencyBound({ type: drafts[index].type, lagDays: resolved.lagDays }, resolved.predecessor, calendarMath);
      if (candidate && candidate.date > (nextDates[candidate.endpoint] ?? '') && candidate.date > (earliestDates[candidate.endpoint] ?? '')) {
        earliestDates[candidate.endpoint] = candidate.date;
      }
    } catch (cause) {
      if (!(cause instanceof CalendarError)) throw cause;
    }
  }

  useEffect(() => {
    dirtyRef.current = dirty;
    onDraftChange(GANTT_ROW_SCHEDULE_DRAFT, dirty, Boolean(pending));
  }, [dirty, onDraftChange, pending]);
  useEffect(() => {
    initialDateInput.current?.focus({ preventScroll: focusDate !== 'dueDate' });
  }, [focusDate]);
  useEffect(() => () => {
    request.current?.abort();
    onDraftChange(GANTT_ROW_SCHEDULE_DRAFT, false, false);
  }, [onDraftChange]);
  useEffect(() => {
    if (!result?.previewId) return;
    const timer = setInterval(() => setClock(currentTime()), 5_000);
    return () => clearInterval(timer);
  }, [result?.previewId]);
  useEffect(() => {
    if (pending) {
      modal.current?.focus({ preventScroll: true });
      return;
    }
    if (!focusAfter.current || document.activeElement !== modal.current) return;
    const target = focusAfter.current === 'review' ? reviewHeading : focusAfter.current === 'recover' ? recoverButton : errorNotice;
    focusAfter.current = null;
    target.current?.focus();
  }, [pending]);

  function close() {
    if (request.current) { notify('일정 요청 결과를 확인한 뒤 닫아 주세요.', 'error'); return; }
    if (dirtyRef.current && !window.confirm(retryId
      ? '일정과 연결이 이미 변경됐을 수 있습니다. 적용 결과 확인을 닫을까요?'
      : initialDateDraft !== undefined ? '이 편집 창에서 바꾼 내용과 검토 결과를 버리고 닫을까요?'
        : '입력한 날짜와 연결, 검토 결과를 버리고 닫을까요?')) return;
    onDraftChange(GANTT_ROW_SCHEDULE_DRAFT, false, false);
    onClose();
  }

  function handleKeys(event: KeyboardEvent<HTMLElement>) {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button, input, select, summary'))
      .filter(element => !element.matches(':disabled') && element.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    const active = document.activeElement;
    if (!first || (event.shiftKey ? active === first : active === last) || active === event.currentTarget) {
      event.preventDefault();
      (event.shiftKey ? last ?? event.currentTarget : first ?? event.currentTarget).focus();
    }
  }

  function invalidate() {
    setReview(null);
    setError('');
    setNotice('');
    dirtyRef.current = true;
    onDraftChange(GANTT_ROW_SCHEDULE_DRAFT, true, false);
  }

  function changeDate(field: DateField, value: string) {
    setEditedDates(previous => ({ ...previous, [field]: value || null }));
    releaseSuggestedDate(field);
    invalidate();
  }

  function releaseSuggestedDate(field: DateField) {
    setSuggestionOverrides(previous => {
      if (!Object.hasOwn(previous, field)) return previous;
      const next = { ...previous };
      delete next[field];
      return next;
    });
  }

  function adoptSavedDate(field: DateField) {
    document.getElementById(`${uid}-${field}`)?.focus({ preventScroll: true });
    setEditedDates(previous => {
      const next = { ...previous };
      delete next[field];
      return next;
    });
    releaseSuggestedDate(field);
    invalidate();
  }

  function useSuggestedDates(range: { startDate: string; endDate: string }) {
    const next = { ...editedDates };
    const overrides = { ...suggestionOverrides };
    for (const field of scheduleEndpoints) {
      if (nextDates[field]) continue;
      overrides[field] = editedDates[field];
      next[field] = range[field];
    }
    setSuggestionOverrides(overrides);
    setEditedDates(next);
    invalidate();
    requestAnimationFrame(() => previewButton.current?.focus());
  }

  function recalculateSuggestedDates() {
    const next = { ...editedDates };
    for (const field of scheduleEndpoints) {
      if (!Object.hasOwn(suggestionOverrides, field)) continue;
      const previous = suggestionOverrides[field];
      if (previous === undefined) delete next[field];
      else next[field] = previous;
    }
    setEditedDates(next);
    setSuggestionOverrides({});
    invalidate();
    requestAnimationFrame(() => (suggestionDurationInput.current ?? initialDateInput.current)?.focus());
  }

  function changeDraft(id: number, changes: LinkDraftChanges) {
    setDrafts(previous => previous.map(draft => draft.id === id ? { ...draft, ...changes } : draft));
    invalidate();
  }

  function focusDraft(id: number) {
    requestAnimationFrame(() => modal.current?.querySelector<HTMLElement>(`[data-link-draft="${id}"]`)?.focus());
  }

  function appendDraft() {
    if (drafts.length >= MAX_SCHEDULE_ROW_DEPENDENCY_EDITS) return;
    const draft = linkDraft(nextDraftId.current++);
    setDrafts(previous => [...previous, draft]);
    invalidate();
    focusDraft(draft.id);
  }

  function removeDraft(index: number) {
    const focus = drafts[index + 1] ?? drafts[index - 1];
    if (!focus) return;
    const id = drafts[index].id;
    setDrafts(previous => previous.filter(draft => draft.id !== id));
    invalidate();
    focusDraft(focus.id);
  }

  function begin(kind: Pending) {
    if (request.current) return null;
    const controller = new AbortController();
    request.current = controller;
    focusAfter.current = null;
    setPending(kind);
    setError('');
    setNotice('');
    onDraftChange(GANTT_ROW_SCHEDULE_DRAFT, dirtyRef.current, true);
    return controller;
  }

  function finish(controller: AbortController) {
    if (request.current !== controller || controller.signal.aborted) return;
    request.current = null;
    setPending(null);
    onDraftChange(GANTT_ROW_SCHEDULE_DRAFT, dirtyRef.current, false);
  }

  async function preview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canPreview || editLocked || reloadNeeded) return;
    const controller = begin('preview');
    if (!controller) return;
    setReview(null);
    try {
      const result = await api<SchedulePastePreview>('/schedule/row-edit/preview', {
        method: 'POST', headers: { 'X-Actor-Id': actorId }, body: JSON.stringify(payload), signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setReview({ input, result, editGroups, anchorVersion: payload.issue.expectedVersion });
      setClock(currentTime());
      focusAfter.current = 'review';
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(`${errorMessage(cause)} 날짜와 연결 입력을 유지했습니다.`);
      if (cause instanceof ApiError && [404, 409].includes(cause.status)) setReloadNeeded(true);
      focusAfter.current = 'error';
    } finally { finish(controller); }
  }

  async function reloadTargets() {
    const controller = begin('reload');
    if (!controller) return;
    setReview(null);
    try {
      await refresh();
      if (controller.signal.aborted) return;
      setReloadNeeded(false);
      setNotice('입력한 날짜와 연결을 유지했습니다. 최신 업무 기준으로 다시 미리보기를 만들어 주세요.');
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(`${errorMessage(cause)} 날짜와 연결 입력을 유지했습니다.`);
      focusAfter.current = 'error';
    } finally { finish(controller); }
  }

  async function reflect(appliedReview: AppliedReview, controller: AbortController) {
    try { await onApplied(appliedReview.result, appliedReview.anchorVersion); }
    catch (cause) {
      if (controller.signal.aborted) return;
      setError(`일정과 연결은 적용되었습니다. ${errorMessage(cause)} 화면에 다시 반영할 수 있습니다.`);
      focusAfter.current = 'error';
    }
  }

  async function apply(previewId: string, recovering: boolean) {
    const current = currentTime();
    if (review?.result.previewId !== previewId || (recovering ? retryId !== previewId : applyId !== previewId || current >= expiry)) {
      setClock(current);
      return;
    }
    const controller = begin(recovering ? 'recover' : 'apply');
    if (!controller) return;
    try {
      const recorded = await api<SchedulePasteApplyResult>('/schedule/row-edit/apply', {
        method: 'POST', headers: scheduleUndoHeaders(undoScope, actorId),
        body: JSON.stringify({ previewId }), signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!recorded || typeof recorded.undoId !== 'string' || !recorded.undoId ||
        !Array.isArray(recorded.updated) || !Array.isArray(recorded.warnings) ||
        !(recorded.updated.length || recorded.dependencyChanges)) throw new Error('일정 적용 응답을 확인할 수 없습니다.');
      setRetryId(null);
      const appliedReview = { result: recorded, anchorVersion: review.anchorVersion };
      setApplied(appliedReview);
      dirtyRef.current = false;
      onDraftChange(GANTT_ROW_SCHEDULE_DRAFT, false, true);
      await reflect(appliedReview, controller);
    } catch (cause) {
      if (controller.signal.aborted) return;
      const rejected = definiteRejection(cause, recovering);
      setRetryId(rejected ? null : previewId);
      if (rejected) {
        setReview(null);
        if (cause instanceof ApiError && [404, 409, 410].includes(cause.status)) setReloadNeeded(true);
      }
      setError(rejected
        ? `${errorMessage(cause)} 날짜와 연결 입력을 유지했습니다. 다시 미리보기를 만들어 주세요.`
        : '적용 여부를 확인하지 못했습니다. 같은 요청으로 적용 결과를 다시 확인해 주세요.');
      focusAfter.current = rejected ? 'error' : 'recover';
    } finally { finish(controller); }
  }

  async function retryReflection() {
    if (!applied) return;
    const controller = begin('reflect');
    if (!controller) return;
    try { await reflect(applied, controller); }
    finally { finish(controller); }
  }

  return <div className="schedule-paste-overlay">
    <section className="schedule-paste-dialog gantt-row-schedule-edit" ref={modal} role="dialog" aria-modal="true"
      aria-labelledby={`${uid}-title`} aria-describedby={`${uid}-issue`} aria-busy={Boolean(pending)} tabIndex={-1} onKeyDown={handleKeys}>
      <header>
        <div><h2 id={`${uid}-title`}><CalendarRange size={20} aria-hidden="true" />업무 일정과 연결 편집</h2>
          <p id={`${uid}-issue`}>{issueText(anchor)}</p></div>
        <button className="btn btn-ghost" aria-label="일정과 연결 편집 닫기" type="button" disabled={Boolean(pending)}
          onClick={close}><X size={20} aria-hidden="true" /></button>
      </header>
      {!currentIssue && <p className="schedule-paste-error gantt-row-edit-missing" role="alert">현재 프로젝트에서 업무를 찾을 수 없습니다.</p>}
      {currentIssue && transferredDatesStale &&
        <p className="schedule-paste-warnings gantt-row-edit-warning" role="status">업무가 변경됐습니다. 미리보기에서 저장된 날짜와 입력한 날짜를 비교해 주세요.</p>}
      <form className="schedule-paste-input" onSubmit={preview}>
        <fieldset disabled={editLocked || !currentIssue} className="gantt-row-edit-fields">
          <legend>날짜</legend>
          <div className="gantt-row-edit-columns">
            {dates.map(({ field, label }) => {
              const conflicting = transferredDatesStale && Object.hasOwn(initialDates ?? {}, field) &&
                anchor[field] !== initialDateDraft[field] && nextDates[field] !== anchor[field];
              return <div className="gantt-row-edit-control" key={field}>
                <label htmlFor={`${uid}-${field}`}>{label}</label>
                <div className="gantt-row-edit-date">
                  <input id={`${uid}-${field}`} className="field" type="date" ref={field === (focusDate ?? 'startDate') ? initialDateInput : undefined}
                    value={nextDates[field] ?? ''} max={MAX_CALENDAR_DATE} aria-describedby={conflicting ? `${uid}-saved-${field}` : undefined}
                    onChange={event => changeDate(field, event.currentTarget.value)} />
                  {nextDates[field] && <button className="btn btn-ghost" aria-label={`${label} 비우기`} title={`${label} 비우기`}
                    type="button" onClick={() => changeDate(field, '')}><X size={15} aria-hidden="true" /></button>}
                </div>
                {conflicting && <div className="gantt-row-edit-date-conflict">
                  <span id={`${uid}-saved-${field}`}>현재 저장값 <strong>{anchor[field] ?? '미정'}</strong></span>
                  <button className="btn btn-ghost" type="button" aria-label={`${label} 저장값 사용`}
                    onClick={() => adoptSavedDate(field)}>저장값 사용</button>
                </div>}
              </div>;
            })}
          </div>
          {incomingTeamBlockers.length > 0 && <details className="gantt-row-edit-existing">
            <summary>프로젝트 간 선행 업무 {incomingTeamBlockers.length}개</summary>
            <ul>{incomingTeamBlockers.map(({ relation, source }) => <li key={relation.id}>
              <strong>{issueText(source)}</strong>
              <span>종료일 {source.endDate ?? '미정'} · {ruleText({ type: 'FS', lagDays: 0 })}{relation.origin === 'jira' && ' · Jira 이관 관계'}</span>
            </li>)}</ul>
          </details>}
          {showMissingDateSuggestion && <MissingDateSuggestion
            startDate={nextDates.startDate} endDate={nextDates.endDate} calendarMath={calendarMath}
            links={linksValid ? [
              ...linksForDateSuggestion(links, edits, projectIssues),
              ...incomingTeamBlockers.map(({ source }): MissingScheduleLink => ({ role: 'predecessor', type: 'FS', lagDays: 0, other: source })),
            ] : null}
            duration={suggestionDuration} durationInput={suggestionDurationInput} onDurationChange={setSuggestionDuration}
            disabled={editLocked || !currentIssue || reloadNeeded} onUse={useSuggestedDates} />}
          {suggestionApplied && <div className="gantt-row-edit-actions">
            <button className="btn" type="button" disabled={reloadNeeded} onClick={recalculateSuggestedDates}>제안 날짜 다시 계산</button>
          </div>}
          <WorkingDayRangePicker calendarMath={calendarMath} startDate={nextDates.startDate ?? null} endDate={nextDates.endDate ?? null}
            disabled={editLocked || !currentIssue} onApply={range => {
              setEditedDates(previous => ({ ...previous, ...range }));
              setSuggestionOverrides({});
              invalidate();
            }} />
        </fieldset>
        <fieldset disabled={editLocked || !currentIssue} className="gantt-row-edit-fields">
          <legend>선후행 연결</legend>
          {links.length > 0 && <details className="gantt-row-edit-existing">
            <summary>현재 연결 {links.length}개</summary>
            <ul>{links.map(({ dependency, other, role }) => <li key={dependency.id}>
              <strong>{issueText(other)}</strong><span>{role === 'predecessor' ? '선행 업무' : '후행 업무'} · {ruleText(dependency)}</span>
            </li>)}</ul>
          </details>}
          <div className="gantt-row-edit-drafts" data-multiple={drafts.length > 1 || undefined}>
            {drafts.map((draft, index) => <GanttRowDependencyFields key={draft.id} draft={draft} name={`연결 변경 ${index + 1}`}
              anchorId={anchor.id} projectIssues={projectIssues} issueAliases={issueAliases} links={links} resolved={resolvedDrafts[index]}
              duplicateDraft={duplicateDraft(resolvedDrafts[index])} onChange={changes => changeDraft(draft.id, changes)}
              onRemove={drafts.length > 1 ? () => removeDraft(index) : undefined} />)}
          </div>
          <button className="btn gantt-row-edit-append" type="button" onClick={appendDraft} disabled={drafts.length >= MAX_SCHEDULE_ROW_DEPENDENCY_EDITS}>
            <Plus size={15} aria-hidden="true" />연결 변경 추가
          </button>
          {drafts.length >= MAX_SCHEDULE_ROW_DEPENDENCY_EDITS && <p className="gantt-row-edit-hint">한 번에 연결 변경 {MAX_SCHEDULE_ROW_DEPENDENCY_EDITS}개까지 검토할 수 있습니다.</p>}
          {scheduleEndpoints.map(endpoint => {
            const date = earliestDates[endpoint];
            if (!date) return null;
            return <div key={endpoint} className="gantt-row-edit-suggestion">
              <span>{SCHEDULE_DATE_LABELS[endpoint]} 제안 <strong>{date}</strong></span>
              <button className="btn" type="button" onClick={() => changeDate(endpoint, date)}>
                {drafts.length === 1 ? '가장 이른 날짜 사용' : `가장 이른 ${SCHEDULE_DATE_LABELS[endpoint]} 사용`}
              </button>
            </div>;
          })}
          <div className="gantt-row-edit-cascade">
            <label>
              <input type="checkbox" checked={rescheduleSuccessors} aria-describedby={`${uid}-reschedule-help`}
                onChange={event => {
                  setRescheduleSuccessors(event.currentTarget.checked);
                  invalidate();
                }} />
              후행 일정 함께 검토
            </label>
            <p id={`${uid}-reschedule-help`} className="gantt-row-edit-hint">
              선택한 업무는 위 날짜를 유지합니다. 변경할 연결을 기준으로 후행 업무의 근무일 기간을 유지하며 일정을 필요한 만큼 늦춥니다.
            </p>
          </div>
        </fieldset>
        <div className="gantt-row-edit-actions">
          <button ref={previewButton} className="btn btn-primary" type="submit" disabled={editLocked || !canPreview || reloadNeeded}>변경 미리보기</button>
          <button className="btn" type="button" disabled={editLocked} onClick={() => void reloadTargets()}>
            <RefreshCw size={15} aria-hidden="true" />최신 업무 불러오기
          </button>
        </div>
      </form>
      {(pending || error || notice || result || applied) && <div className="schedule-paste-results gantt-row-edit-review">
        {pending && <p className="schedule-paste-pending" role="status"><Loader2 className="spin" size={17} aria-hidden="true" />{pendingLabels[pending]}</p>}
        {error && <p className="schedule-paste-error" role="alert" tabIndex={-1} ref={errorNotice}>{error}</p>}
        {notice && <p className="schedule-paste-success" role="status">{notice}</p>}
        {applied && <p className="schedule-paste-success" role="status">적용한 일정과 연결은 간트에서 되돌릴 수 있습니다.</p>}
        {result && <section aria-label="일정과 연결 미리보기">
          <h3 tabIndex={-1} ref={reviewHeading}>일정과 연결 미리보기</h3>
          {result.errors.length > 0 && <ul className="schedule-paste-rejected" role="alert">{result.errors.map((entry, index) => {
            const group = reviewGroup(entry.line);
            return <li key={index}>{group && `${group} · `}{entry.key && `${entry.key} · `}{entry.message}</li>;
          })}</ul>}
          {!result.errors.length && !hasChanges(result) && <p className="schedule-paste-noop" role="status">적용할 변경이 없습니다.</p>}
          {reviewStale && !retryId && !applied && <p className="schedule-paste-stale" role="status">일정 조건이 바뀌었거나 미리보기가 만료되었습니다. 다시 검토해 주세요.</p>}
          {result.changes.map(change => <div className="gantt-row-edit-diff" key={change.id}>
            {rescheduleSuccessors && <header className="gantt-row-edit-diff-title">
              <h4>{change.key} · {change.title}</h4>
              <small className="gantt-row-edit-hint">{change.id === anchor.id ? '선택한 업무' : '후행 업무'}</small>
            </header>}
            <dl>{dates.filter(({ from, to }) => (change[from] ?? null) !== (change[to] ?? null)).map(({ field, label, from, to }) =>
              <div key={field}><dt>{label}</dt><dd>{change[from] ?? '미정'} → <strong>{change[to] ?? '미정'}</strong></dd></div>)}</dl>
          </div>)}
          {result.dependencyChanges?.map(change => <div className="gantt-row-edit-link-diff" key={change.line}>
            {reviewGroup(change.line) && <small className="gantt-row-edit-hint">{reviewGroup(change.line)}</small>}
            <h4>{change.predecessorKey} → {change.successorKey}</h4>
            <p>{ruleText(change.before)} → <strong>{ruleText(change.after)}</strong></p>
          </div>)}
          {result.warnings.length > 0 && <div className="schedule-paste-warnings">
            <h4>일정 경고</h4><ul>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
          </div>}
        </section>}
      </div>}
      <footer>
        <button className="btn btn-ghost" type="button" disabled={Boolean(pending)} onClick={close}>닫기</button>
        {applied ? <button className="btn btn-primary" type="button" disabled={Boolean(pending)} onClick={() => void retryReflection()}>
          화면에 다시 반영
        </button> : retryId ? <button ref={recoverButton} className="btn btn-primary" type="button" disabled={Boolean(pending)}
          onClick={() => void apply(retryId, true)}>적용 결과 다시 확인</button> :
          <button className="btn btn-primary" type="button" disabled={!applyId}
            onClick={() => { if (applyId) void apply(applyId, false); }}><Check size={15} aria-hidden="true" />일정과 연결 적용</button>}
      </footer>
    </section>
  </div>;
}

function MissingDateSuggestion({ startDate, endDate, calendarMath, links, duration, durationInput, onDurationChange, disabled, onUse }: {
  startDate: string | null;
  endDate: string | null;
  calendarMath: ReturnType<typeof createCalendarMath>;
  links: MissingScheduleLink[] | null;
  duration: string;
  durationInput: React.Ref<HTMLInputElement>;
  onDurationChange: (value: string) => void;
  disabled: boolean;
  onUse: (dates: { startDate: string; endDate: string }) => void;
}) {
  const uid = useId();
  const workingDays = /^\d+$/u.test(duration.trim()) ? Number(duration) : NaN;
  const validDuration = Number.isSafeInteger(workingDays) && workingDays >= 1 && workingDays <= MAX_WORKING_DURATION_DAYS;
  const suggestion = links && validDuration
    ? suggestMissingScheduleDates({ startDate, endDate, notBefore: todayDate(), workingDays, links, calendarMath })
    : null;
  const range = suggestion?.dates;
  return <section className="gantt-missing-date-suggestion" aria-labelledby={`${uid}-heading`}>
    <h3 id={`${uid}-heading`}>선후행 연결로 날짜 제안</h3>
    <div className="gantt-missing-date-suggestion-controls">
      <label>제안 근무일 수<input ref={durationInput} className="field" type="text" inputMode="numeric" value={duration}
        disabled={disabled} aria-invalid={!validDuration || undefined} onChange={event => onDurationChange(event.currentTarget.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.preventDefault(); }} /></label>
      <button className="btn" type="button" disabled={disabled || !range} onClick={() => { if (range) onUse(range); }}>
        제안 날짜 입력
      </button>
    </div>
    <div aria-live="polite">
      {range && <p><output aria-label="제안 날짜 범위"><strong>{range.startDate}</strong> ~ <strong>{range.endDate}</strong></output></p>}
      {!validDuration && <p>근무일 수는 1~3,650 사이의 정수로 입력해 주세요.</p>}
      {links === null && <p>선후행 연결 입력을 확인한 뒤 날짜를 제안할 수 있습니다.</p>}
      {suggestion?.pendingKeys.length ? <p>날짜 확인이 필요한 연결 · {suggestion.pendingKeys.join(', ')}</p> : null}
      {suggestion?.conflicts.length ? <ul>{suggestion.conflicts.map(message => <li key={message}>{message}</li>)}</ul> : null}
    </div>
  </section>;
}

function GanttRowDependencyFields({ draft, name, anchorId, projectIssues, issueAliases, links, resolved, duplicateDraft, onChange, onRemove }: {
  draft: LinkDraft;
  name: string;
  anchorId: string;
  projectIssues: ReadonlyMap<string, Issue>;
  issueAliases?: WorkspaceSnapshot['issueAliases'];
  links: readonly ExistingLink[];
  resolved: DraftResolution;
  duplicateDraft: boolean;
  onChange: (changes: LinkDraftChanges) => void;
  onRemove?: () => void;
}) {
  const uid = useId();
  const searchInput = useRef<HTMLInputElement>(null);
  const directionSelect = useRef<HTMLSelectElement>(null);
  const resultsList = useRef<HTMLUListElement>(null);
  const { action, direction, query, relatedId, dependencyId, type, lag } = draft;
  const { related, selected, duplicateExisting } = resolved;
  const candidates = useMemo(() => {
    if (action !== 'add' || related) return [];
    const available = [...projectIssues.values()].filter(item => item.id !== anchorId)
      .sort((left, right) => left.key.localeCompare(right.key, 'ko', { numeric: true }));
    return searchIssueCandidates({ issueAliases }, available, query, issueText);
  }, [action, anchorId, issueAliases, query, projectIssues, related]);
  const exactMatches = candidates.filter(candidate => candidate.rank < 2);
  const ambiguousAlias = (exactMatches.length > 1 && exactMatches.some(candidate => candidate.rank === 1)) ||
    (!exactMatches.length && candidates.length > 1 && candidates.some(candidate => candidate.matchedAliases.length > 0));

  function chooseLink(id: string) {
    const link = links.find(entry => entry.dependency.id === id);
    onChange({ dependencyId: id, type: link?.dependency.type ?? 'FS', lag: String(link?.dependency.lagDays ?? 0) });
  }

  function chooseRelated(item: Issue) {
    onChange({ relatedId: item.id });
    requestAnimationFrame(() => directionSelect.current?.focus({ preventScroll: true }));
  }

  function handleCandidateKeys(event: KeyboardEvent<HTMLElement>) {
    if (event.nativeEvent.isComposing) return;
    const buttons = Array.from(resultsList.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' && buttons[index + 1]) {
      event.preventDefault();
      buttons[index + 1].focus();
    } else if (event.key === 'ArrowUp' && index >= 0) {
      event.preventDefault();
      (buttons[index - 1] ?? searchInput.current)?.focus();
    } else if (event.key === 'Enter' && event.target === searchInput.current) {
      event.preventDefault();
      if (ambiguousAlias) buttons[0]?.focus();
      else if (candidates[0]) chooseRelated(candidates[0].issue);
    }
  }

  return <div className="gantt-row-edit-draft" role="group" aria-label={name}>
    {onRemove && <div className="gantt-row-edit-draft-heading">
      <strong>{name}</strong>
      <button className="btn btn-ghost" type="button" aria-label={`${name} 빼기`} onClick={onRemove}>
        <X size={14} aria-hidden="true" />빼기
      </button>
    </div>}
    <div className="gantt-row-edit-control">
      <label htmlFor={`${uid}-action`}>선후행 연결 작업</label>
      <select id={`${uid}-action`} className="field" data-link-draft={draft.id} value={action}
        onChange={event => onChange({ ...defaultLinkDraft, action: event.currentTarget.value as LinkAction })}>
        <option value="none">변경 없음</option><option value="add">연결 추가</option>
        <option value="update" disabled={!links.length}>연결 수정</option><option value="remove" disabled={!links.length}>연결 해제</option>
      </select>
    </div>
    {action === 'add' && (related ? <div className="gantt-row-edit-selection">
      <span>{issueText(related)}</span>
      <button className="btn btn-ghost" type="button" onClick={() => {
        onChange({ relatedId: '' });
        requestAnimationFrame(() => searchInput.current?.focus());
      }}>다시 검색</button>
    </div> : <div onKeyDown={handleCandidateKeys}>
      <div className="gantt-row-edit-control">
        <label htmlFor={`${uid}-search`}>연결할 업무 검색</label>
        <input id={`${uid}-search`} className="field" type="text" ref={searchInput} aria-controls={`${uid}-results`}
          value={query} placeholder="업무 키, 이전 키 또는 제목" onChange={event => onChange({ query: event.currentTarget.value })} />
      </div>
      {relatedId && <p className="gantt-row-edit-hint" role="status">선택한 업무가 목록에서 사라졌습니다. 연결할 업무를 다시 선택하세요.</p>}
      <ul className="gantt-row-edit-results" id={`${uid}-results`} ref={resultsList} aria-label="연결할 업무 검색 결과">
        {candidates.slice(0, 12).map(({ issue, matchedAliases }) => <li key={issue.id}>
          <button type="button" className="btn btn-ghost" onClick={() => chooseRelated(issue)}><span>{issueText(issue)}
            {matchedAliases.length > 0 && <small className="gantt-candidate-alias">{matchedAliases.map(issueSearchAliasLabel).join(' · ')}</small>}
          </span></button>
        </li>)}
      </ul>
      {ambiguousAlias && <p className="gantt-row-edit-hint" role="status">검색에 일치하는 업무가 여러 개입니다. 현재 키와 제목을 확인해 선택하세요.</p>}
      {!candidates.length && <p className="gantt-row-edit-hint">같은 프로젝트에 일치하는 업무가 없습니다.</p>}
      {candidates.length > 12 && <p className="gantt-row-edit-hint">검색 조건으로 업무를 더 좁힐 수 있습니다.</p>}
    </div>)}
    {action === 'add' && <div className="gantt-row-edit-control">
      <label htmlFor={`${uid}-direction`}>연결 방향</label>
      <select id={`${uid}-direction`} className="field" value={direction} ref={directionSelect}
        onChange={event => onChange({ direction: event.currentTarget.value as Direction })}>
        <option value="predecessor">선택한 업무가 선행</option><option value="successor">선택한 업무가 후행</option>
      </select>
    </div>}
    {duplicateExisting && <p className="gantt-row-edit-hint" role="status">같은 방향의 연결이 있습니다. 연결 수정에서 해당 연결을 선택할 수 있습니다.</p>}
    {duplicateDraft && <p className="gantt-row-edit-hint" role="status">같은 연결을 여러 번 변경할 수 없습니다.</p>}
    {(action === 'update' || action === 'remove') && <div className="gantt-row-edit-control">
      <label htmlFor={`${uid}-dependency`}>편집할 연결</label>
      <select id={`${uid}-dependency`} className="field" value={dependencyId} onChange={event => chooseLink(event.currentTarget.value)}>
        <option value="">연결 선택</option>
        {dependencyId && !selected && <option value={dependencyId} disabled>현재 목록에서 사라진 연결</option>}
        {links.map(({ dependency, other, role }) => <option key={dependency.id} value={dependency.id}>
          {issueText(other)} · {role === 'predecessor' ? '선행' : '후행'}
        </option>)}
      </select>
    </div>}
    {(action === 'add' || action === 'update' && selected) && <div className="gantt-row-edit-columns">
      <div className="gantt-row-edit-control">
        <label htmlFor={`${uid}-type`}>연결 유형</label>
        <select id={`${uid}-type`} className="field" value={type} onChange={event => onChange({ type: event.currentTarget.value as DependencyType })}>
          {DEPENDENCY_TYPES.map(value => <option key={value} value={value}>{DEPENDENCY_LABELS[value]} ({value})</option>)}
        </select>
      </div>
      <div className="gantt-row-edit-control">
        <label htmlFor={`${uid}-lag`}>간격 (근무일)</label>
        <input id={`${uid}-lag`} className="field" type="number" step={1} min={-MAX_DEPENDENCY_LAG_DAYS} max={MAX_DEPENDENCY_LAG_DAYS}
          value={lag} onChange={event => onChange({ lag: event.currentTarget.value })} />
      </div>
    </div>}
  </div>;
}
