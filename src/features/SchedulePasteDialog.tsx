'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowDown, CalendarRange, Check, ClipboardList, Link2, Loader2, RefreshCw, X } from 'lucide-react';
import { DEPENDENCY_LABELS, isDependencyLag } from '../../shared/schedule-dependencies';
import { MAX_SCHEDULE_BLOCKER_LINKS, MAX_SCHEDULE_BULK_LINK_ISSUES } from '../../shared/types';
import type {
  Dependency, FeatureProps, Issue, Project, ScheduleBlockerLinkInput, ScheduleBulkDateChanges, ScheduleBulkDateInput,
  ScheduleBulkLinkInput, ScheduleChange, SchedulePasteApplyResult, SchedulePasteDependencyChange, SchedulePastePreview, ScheduleUndoScope, TeamScheduleBlocker,
} from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { GanttBlockerLinkPicker, type BlockerLinkSelection } from './GanttBlockerLinksDialog';
import { GanttBulkLinkFields, type BulkLinkDraft } from './GanttBulkLinksDialog';
import { scheduleUndoHeaders } from './schedule-undo';
import './schedule-paste.css';

type BulkDates = { issues: readonly Issue[]; projects: readonly Project[]; refresh: () => Promise<void> };
type BulkLinks = { issues: readonly Issue[]; candidates: readonly Issue[]; refresh: () => Promise<void> };
type BlockerLinks = { issues: readonly Issue[]; dependencies: readonly Dependency[]; projects?: readonly Project[]; refresh: () => Promise<void> };
type TeamPaste = { projects: readonly Project[] };
type ProjectName = Pick<Project, 'id' | 'name'>;
type ProjectLabels = ReadonlyMap<string, ProjectName>;

export type SchedulePasteDialogProps = {
  actorId: string;
  undoScope: ScheduleUndoScope;
  notify: FeatureProps['notify'];
  onClose: (awaitingResult?: boolean) => void;
  onDraftChange: (id: string, dirty: boolean, pending?: boolean, awaitingResult?: boolean) => void;
  onApplied: (result: SchedulePasteApplyResult) => Promise<void>;
} & (
  | { projectId: string; projectLabel?: string; bulkDates?: never; bulkLinks?: BulkLinks; blockerLinks?: never; teamPaste?: never }
  | { projectId: string | null; projectLabel?: string; bulkDates?: never; bulkLinks?: never; blockerLinks: BlockerLinks; teamPaste?: never }
  | { projectId: string | null; projectLabel?: never; bulkDates: BulkDates; bulkLinks?: never; blockerLinks?: never; teamPaste?: never }
  | { projectId: null; projectLabel?: never; bulkDates?: never; bulkLinks?: never; blockerLinks?: never; teamPaste: TeamPaste }
);

type Review = { input: string; targets: string; projects?: ProjectLabels; result: SchedulePastePreview };
type DateField = 'startDate' | 'endDate' | 'dueDate';
type DateAction = 'keep' | 'set' | 'clear';
type DateEntry = { action: DateAction; value: string };
type DateDraft = Record<DateField, DateEntry>;
export const SCHEDULE_PASTE_DRAFT_ID = 'schedule-paste';
const BULK_DRAFT_ID = 'schedule-bulk-dates';
const BULK_LINK_DRAFT_ID = 'schedule-bulk-links';
const BLOCKER_LINK_DRAFT_ID = 'schedule-blocker-links';
const PAGE_SIZE = 50;
const bulkFields: { field: DateField; label: string }[] = [
  { field: 'startDate', label: '시작일' },
  { field: 'endDate', label: '종료일' },
  { field: 'dueDate', label: '목표 마감일' },
];
const keepDate: DateEntry = { action: 'keep', value: '' };
const defaultLink: BulkLinkDraft = { choice: null, direction: 'predecessor', type: 'FS', lagDays: '0' };
const hasLinkInput = (link: BulkLinkDraft, query: string) =>
  Boolean(link.choice || query || link.direction !== defaultLink.direction || link.type !== defaultLink.type || link.lagDays !== defaultLink.lagDays);
const pendingLabels = {
  preview: '입력한 일정표를 검토하는 중입니다.',
  apply: '검토한 일정을 적용하는 중입니다.',
  recover: '이전 적용 요청의 결과를 확인하는 중입니다.',
  reload: '선택한 업무의 최신 상태를 불러오는 중입니다.',
  reflect: '적용 결과를 화면에 반영하는 중입니다.',
};
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : '일정 요청을 완료하지 못했습니다.';
const hasChanges = (result: SchedulePastePreview) =>
  result.changes.length > 0 || Boolean(result.dependencyChanges?.length);
const hasDueDateChange = (change: ScheduleChange) => change.fromDue !== undefined || change.toDue !== undefined;
const pairKey = (sourceId: string, targetId: string) => JSON.stringify([sourceId, targetId]);

function isDefiniteApplyRejection(cause: unknown, preserveUnknownResult: boolean, recovering: boolean) {
  if (!(cause instanceof ApiError) || cause.status < 400 || cause.status >= 500) return false;
  if (!preserveUnknownResult) return true;
  if ([408, 425, 429, 499].includes(cause.status)) return false;
  return !recovering || (cause.status !== 401 && cause.status !== 403);
}

export function SchedulePasteDialog(props: SchedulePasteDialogProps) {
  const mode = props.blockerLinks ? 'blockers' : props.bulkLinks ? 'links' : props.bulkDates ? 'dates' : 'paste';
  return <ProjectScheduleEditDialog key={`${props.projectId}:${mode}`} {...props} />;
}

export function bulkDateResultMessage(updated: readonly Issue[], team: boolean) {
  if (!team) return `${updated.length}개 업무의 날짜를 변경했습니다.`;
  const projects = new Set(updated.map(issue => issue.projectId));
  return `프로젝트 ${projects.size}개에서 업무 ${updated.length}개의 날짜를 변경했습니다.`;
}

function ProjectScheduleEditDialog({
  actorId,
  undoScope,
  projectId,
  projectLabel,
  notify,
  onClose,
  onDraftChange,
  onApplied,
  bulkDates,
  bulkLinks,
  blockerLinks,
  teamPaste,
}: SchedulePasteDialogProps) {
  const [text, setText] = useState('');
  const [dates, setDates] = useState<DateDraft>({ startDate: keepDate, endDate: keepDate, dueDate: keepDate });
  const [link, setLink] = useState<BulkLinkDraft>(defaultLink);
  const [anchorQuery, setAnchorQuery] = useState('');
  const [blockerSelection, setBlockerSelection] = useState<BlockerLinkSelection>(() => new Map());
  const [blockerRefreshKey, setBlockerRefreshKey] = useState(0);
  const [review, setReview] = useState<Review | null>(null);
  const [latest, setLatest] = useState<Review | null>(null);
  const [approved, setApproved] = useState(false);
  const [pending, setPending] = useState<'preview' | 'apply' | 'recover' | 'reload' | 'reflect' | null>(null);
  const [retryApply, setRetryApply] = useState<{ previewId: string; input: string } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [applied, setApplied] = useState<SchedulePasteApplyResult | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const dialog = useRef<HTMLElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const pastePreviewButton = useRef<HTMLButtonElement>(null);
  const applyRecoveryButton = useRef<HTMLButtonElement>(null);
  const firstDateAction = useRef<HTMLSelectElement>(null);
  const anchorSearch = useRef<HTMLInputElement>(null);
  const blockerProjectFilter = useRef<HTMLSelectElement>(null);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const dirtyRef = useRef(false);
  const request = useRef<AbortController | null>(null);

  const bulk = bulkDates ?? bulkLinks;
  const bulkIssues = bulk?.issues ?? [];
  const managed = bulk ?? blockerLinks;
  const blockerDialog = Boolean(blockerLinks);
  const directLinks = Boolean(bulkLinks || blockerLinks);
  const isTeamPaste = Boolean(teamPaste);
  const isTeamBlocker = projectId === null && blockerDialog;
  const focusTeamRecovery = isTeamPaste || isTeamBlocker;
  const preserveUnknownResult = Boolean(managed || teamPaste);
  const reportUnknownResult = directLinks || isTeamPaste;
  const draftId = blockerLinks ? BLOCKER_LINK_DRAFT_ID : bulkLinks ? BULK_LINK_DRAFT_ID : bulkDates ? BULK_DRAFT_ID : SCHEDULE_PASTE_DRAFT_ID;
  const team = projectId === null;
  const scopeLabel = focusTeamRecovery ? '전체 프로젝트' : projectLabel ? `대상 프로젝트 ${projectLabel}` : undefined;
  const title = blockerLinks ? '차단 관계 선후행 검토' : bulkLinks ? '선후행 연결 일괄 추가' : bulkDates ? '일정 일괄 편집' : '일정 붙여넣기';
  const datesEdited = bulkFields.some(({ field }) => dates[field].action !== 'keep');
  const linksEdited = hasLinkInput(link, anchorQuery);
  const selectedBlockers = [...blockerSelection.values()];
  const blockerInput: ScheduleBlockerLinkInput | null = blockerLinks
    ? projectId === null ? {
      projectId: null,
      relations: selectedBlockers.flatMap(relation => relation.projectId
        ? [{ id: relation.id, version: relation.version, projectId: relation.projectId }] : []),
    } : { projectId, relations: selectedBlockers.map(({ id, version }) => ({ id, version })) }
    : null;
  const input = blockerInput ? JSON.stringify(blockerInput)
    : bulkLinks ? JSON.stringify([link.choice?.id, link.direction, link.type, link.lagDays])
      : bulkDates ? JSON.stringify(dates) : text;
  const issues = bulkIssues.map(issue => ({ id: issue.id, expectedVersion: issue.version }));
  const selectedIds = new Set(issues.map(issue => issue.id));
  const sameProjectCandidates = bulkLinks?.candidates.filter(issue => issue.projectId === projectId) ?? [];
  const sameProjectIds = new Set(sameProjectCandidates.map(issue => issue.id));
  const unavailableTargets = bulkLinks && bulkIssues.filter(issue => issue.projectId !== projectId || !sameProjectIds.has(issue.id));
  const anchors = sameProjectCandidates.filter(issue => !selectedIds.has(issue.id));
  const anchor = anchors.find(issue => issue.id === link.choice?.id);
  const lagDays = link.lagDays.trim() ? Number(link.lagDays) : NaN;
  const bulkLinkInput: ScheduleBulkLinkInput | null = anchor && projectId !== null && !unavailableTargets?.length &&
    issues.length >= 2 && issues.length <= MAX_SCHEDULE_BULK_LINK_ISSUES && isDependencyLag(lagDays)
    ? { projectId, issues, anchor: { id: anchor.id, expectedVersion: anchor.version }, direction: link.direction, type: link.type, lagDays }
    : null;
  const blockerIssues = blockerLinks?.issues;
  const blockerDependencies = blockerLinks?.dependencies;
  const blockerIssuesById = useMemo(() => new Map(blockerIssues?.map(issue => [issue.id, issue])), [blockerIssues]);
  const dependencyByPair = useMemo(() => new Map(blockerDependencies?.map(dependency =>
    [pairKey(dependency.predecessorId, dependency.successorId), dependency])), [blockerDependencies]);
  const dependencyFor = (relation: TeamScheduleBlocker) =>
    dependencyByPair.get(pairKey(relation.sourceIssueId, relation.targetIssueId));
  const targets = blockerLinks ? JSON.stringify(selectedBlockers.map(relation => {
    const source = blockerIssuesById.get(relation.sourceIssueId);
    const target = blockerIssuesById.get(relation.targetIssueId);
    const dependency = dependencyFor(relation);
    return [source?.version, source?.projectId, target?.version, target?.projectId, dependency?.id, dependency?.version, dependency?.type, dependency?.lagDays];
  })) : bulk ? JSON.stringify([bulkIssues.map(issue => [issue.id, issue.version, issue.projectId]), anchor?.version]) : '';
  const projectNames = team ? new Map(bulkDates?.projects.map(project => [project.id, project.name])) : null;
  const selectedProjects = projectNames && bulkDates ? new Map(bulkDates.issues.map(issue => [issue.id, {
    id: issue.projectId, name: projectNames.get(issue.projectId) ?? '프로젝트 정보 없음',
  }])) : undefined;
  const teamProjectList = teamPaste?.projects ?? (isTeamBlocker ? blockerLinks?.projects : undefined);
  const teamProjects = teamProjectList && new Map(teamProjectList.map(project => [project.id, {
    id: project.id, name: `${project.key} · ${project.name}`,
  }]));
  const projectCount = selectedProjects ? new Set([...selectedProjects.values()].map(project => project.id)).size : undefined;
  const canPreview = blockerInput
    ? selectedBlockers.length > 0 && selectedBlockers.length <= MAX_SCHEDULE_BLOCKER_LINKS &&
      blockerInput.relations.length === selectedBlockers.length
    : bulkLinks
    ? Boolean(bulkLinkInput)
    : bulkDates
      ? issues.length > 0 && datesEdited && bulkFields.every(({ field }) => dates[field].action !== 'set' || dates[field].value)
      : Boolean(text.trim());
  const editLocked = Boolean(pending || applied || (preserveUnknownResult && retryApply));
  const dirty = !applied && Boolean((blockerLinks ? blockerSelection.size : bulkLinks ? linksEdited : bulkDates ? datesEdited : text) || review || latest || error);
  const awaitingResult = Boolean(reportUnknownResult && retryApply);
  const expiresAt = review?.result.expiresAt;
  const expiry = expiresAt ? Date.parse(expiresAt) : NaN;
  const expired = Boolean(review?.result.previewId && Number.isFinite(expiry) && expiry <= clock);
  const validReview = Boolean(
    review &&
      approved &&
      canPreview &&
      review.input === input &&
      review.targets === targets &&
      review.result.previewId &&
      hasChanges(review.result) &&
      !review.result.errors.length &&
      Number.isFinite(expiry) &&
      !expired &&
      !applied,
  );

  useEffect(() => {
    dirtyRef.current = dirty;
    onDraftChange(draftId, dirty, Boolean(pending), awaitingResult);
  }, [draftId, dirty, pending, awaitingResult, onDraftChange]);

  useEffect(() => () => onDraftChange(draftId, false, false), [draftId, onDraftChange]);

  useEffect(() => {
    mounted.current = true;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (blockerProjectFilter.current ?? anchorSearch.current ?? firstDateAction.current ?? textarea.current ?? dialog.current)?.focus({ preventScroll: true });
    return () => {
      mounted.current = false;
      request.current?.abort();
      if (!blockerDialog && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [blockerDialog]);

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!focusTeamRecovery || pending) return;
    if (retryApply || applied) {
      applyRecoveryButton.current?.focus({ preventScroll: true });
    } else if (error) {
      const active = document.activeElement;
      if (!dialog.current?.contains(active) || active?.matches(':disabled')) pastePreviewButton.current?.focus();
    }
  }, [applied, error, focusTeamRecovery, pending, retryApply]);

  const close = useCallback(() => {
    if (busyRef.current) {
      notify('일정 요청 결과를 확인한 뒤 닫아 주세요.', 'error');
      return;
    }
    let confirmation = '붙여넣은 일정과 검토 결과를 버리고 닫을까요?';
    if (directLinks) confirmation = retryApply
      ? '연결이 이미 추가됐을 수 있습니다. 적용 결과 확인을 닫을까요?'
      : blockerLinks
        ? '선택한 차단 관계와 검토 결과를 버리고 닫을까요?'
        : '입력한 선후행 연결과 검토 결과를 버리고 닫을까요?';
    else if (bulkDates || (isTeamPaste && retryApply)) confirmation = retryApply
      ? '일정이 이미 변경됐을 수 있습니다. 적용 결과 확인을 닫을까요?'
      : '입력한 날짜와 검토 결과를 버리고 닫을까요?';
    if (dirtyRef.current && !window.confirm(confirmation)) return;
    dirtyRef.current = false;
    onDraftChange(draftId, false, false);
    if (focusTeamRecovery && retryApply) onClose(true);
    else onClose();
  }, [blockerLinks, bulkDates, directLinks, draftId, focusTeamRecovery, isTeamPaste, notify, onClose, onDraftChange, retryApply]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== 'Tab' || !dialog.current) return;
      const focusable = Array.from(
        dialog.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), summary, a[href], [tabindex="0"]',
        ),
      ).filter((element) => !element.matches(':disabled') && element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first) {
        event.preventDefault();
        dialog.current.focus();
      } else if (
        event.shiftKey &&
        (document.activeElement === first || !dialog.current.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !dialog.current.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [close]);

  function resetReview(edited: boolean) {
    setApproved(false);
    setRetryApply(null);
    setLatest(null);
    setError('');
    setNotice('');
    dirtyRef.current = edited || Boolean(review);
    onDraftChange(draftId, dirtyRef.current, false);
  }

  function updateText(value: string) {
    setText(value);
    resetReview(Boolean(value));
  }

  function updateDate(field: DateField, entry: DateEntry) {
    const next = { ...dates, [field]: entry };
    setDates(next);
    resetReview(bulkFields.some(item => next[item.field].action !== 'keep'));
  }

  function updateLink(next: BulkLinkDraft) {
    setLink(next);
    resetReview(hasLinkInput(next, anchorQuery));
  }

  function updateBlockers(selection: BlockerLinkSelection) {
    setBlockerSelection(selection);
    resetReview(selection.size > 0);
  }

  function blockerDiagnosticLabel(item: SchedulePastePreview['errors'][number]) {
    if (item.key) return item.key;
    const relation = item.line === null ? undefined : selectedBlockers[item.line - 1];
    if (relation) {
      const source = blockerIssuesById.get(relation.sourceIssueId)?.key;
      const target = blockerIssuesById.get(relation.targetIssueId)?.key;
      if (source && target) return `${source} → ${target}`;
    }
    return '선택한 차단 관계';
  }

  function begin(kind: NonNullable<typeof pending>) {
    if (busyRef.current) return null;
    busyRef.current = true;
    setPending(kind);
    setError('');
    onDraftChange(draftId, dirtyRef.current, true, awaitingResult);
    const controller = new AbortController();
    request.current = controller;
    return controller;
  }

  function finish(controller: AbortController, resultUnknown = false) {
    busyRef.current = false;
    if (mounted.current && !controller.signal.aborted) {
      setClock(Date.now());
      setPending(null);
      onDraftChange(draftId, dirtyRef.current, false, resultUnknown);
    }
  }

  async function preview(event: FormEvent) {
    event.preventDefault();
    if (!canPreview || editLocked) return;
    const controller = begin('preview');
    if (!controller) return;
    setApproved(false);
    setRetryApply(null);
    setNotice('');
    const submitted = { input, targets, projects: selectedProjects };
    let payload: { projectId: string | null; text: string } | ScheduleBulkDateInput | ScheduleBulkLinkInput | ScheduleBlockerLinkInput;
    if (blockerInput) payload = blockerInput;
    else if (bulkLinkInput) payload = bulkLinkInput;
    else if (bulkDates) {
      const changes: ScheduleBulkDateChanges = {};
      for (const { field } of bulkFields) {
        const { action, value } = dates[field];
        if (action !== 'keep') changes[field] = action === 'clear' ? null : value;
      }
      payload = { projectId, issues, changes };
    } else payload = { projectId, text };
    try {
      const endpoint = blockerLinks ? '/schedule/blocker-links/preview'
        : bulkLinks ? '/schedule/bulk-links/preview' : bulkDates ? '/schedule/bulk-dates/preview' : '/schedule/paste-preview';
      const result = await api<SchedulePastePreview>(endpoint, {
        method: 'POST',
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!mounted.current || controller.signal.aborted) return;
      const next = { ...submitted, result };
      setLatest(next);
      if (!result.errors.length) {
        setReview(next);
        setApproved(Boolean(result.previewId && hasChanges(result)));
      }
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) {
        setError(
          `${errorMessage(cause)} 입력과 이전 검토 결과를 유지했습니다. 다시 미리보기를 만들어 주세요.`,
        );
      }
    } finally {
      finish(controller);
    }
  }

  async function reloadTargets() {
    if (!managed || editLocked) return;
    const controller = begin('reload');
    if (!controller) return;
    setApproved(false);
    setNotice('');
    try {
      await managed.refresh();
      if (!mounted.current || controller.signal.aborted) return;
      setLatest(null);
      if (blockerLinks) {
        setBlockerRefreshKey(value => value + 1);
        setNotice('차단 관계 선택을 유지했습니다. 변경된 관계는 다시 선택한 뒤 연결 미리보기를 만들어 주세요.');
      } else setNotice(`선택한 업무와 ${bulkLinks ? '연결' : '날짜'} 입력을 유지했습니다. 최신 업무 상태로 미리보기를 다시 만들어 주세요.`);
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) {
        const kept = blockerLinks ? '차단 관계 선택' : `선택한 업무와 ${bulkLinks ? '연결' : '날짜'} 입력`;
        setError(`${errorMessage(cause)} ${kept}은 유지했습니다.`);
      }
    } finally {
      finish(controller);
    }
  }

  async function reflectResult(result: SchedulePasteApplyResult) {
    try {
      await onApplied(result);
    } catch (cause) {
      if (mounted.current) {
        setError(`${directLinks ? '선후행 연결은' : '일정은'} 적용되었습니다. ${errorMessage(cause)} 아래에서 화면 반영을 다시 시도하세요.`);
      }
    }
  }

  async function apply() {
    if (!validReview || !review?.result.previewId) return;
    await requestApply(review.result.previewId, review.input, false);
  }

  async function requestApply(previewId: string, submittedInput: string, recovering: boolean) {
    if (submittedInput !== input || applied) return;
    const controller = begin(recovering ? 'recover' : 'apply');
    if (!controller) return;
    setApproved(false);
    let resultUnknown = false;
    try {
      const endpoint = blockerLinks ? '/schedule/blocker-links/apply'
        : bulkLinks ? '/schedule/bulk-links/apply' : bulkDates ? '/schedule/bulk-dates/apply' : '/schedule/paste-apply';
      const result = await api<SchedulePasteApplyResult>(endpoint, {
        method: 'POST',
        headers: scheduleUndoHeaders(undoScope, actorId),
        body: JSON.stringify({ previewId }),
        signal: controller.signal,
      });
      if (!mounted.current || controller.signal.aborted) return;
      if (
        !result ||
        typeof result.undoId !== 'string' ||
        !Array.isArray(result.updated) ||
        !Array.isArray(result.warnings)
      ) {
        throw new Error('적용 응답 형식을 확인하지 못했습니다.');
      }
      setRetryApply(null);
      setApplied(result);
      dirtyRef.current = false;
      onDraftChange(draftId, false, true);
      await reflectResult(result);
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) {
        if (isDefiniteApplyRejection(cause, preserveUnknownResult, recovering)) {
          setRetryApply(null);
          setError(
            `${errorMessage(cause)} 입력과 검토 결과를 유지했습니다. 최신 조건으로 새 미리보기를 만들어 주세요.`,
          );
        } else {
          resultUnknown = true;
          setRetryApply({ previewId, input: submittedInput });
          setError(
            `${errorMessage(cause)} 적용 여부를 확인하지 못했습니다. 입력과 검토 결과를 유지했으므로 같은 적용 요청의 결과를 다시 확인하세요.`,
          );
        }
      }
    } finally {
      finish(controller, reportUnknownResult && resultUnknown);
    }
  }

  async function retryReflection() {
    if (!applied) return;
    const controller = begin('reflect');
    if (!controller) return;
    try {
      await reflectResult(applied);
    } finally {
      finish(controller);
    }
  }

  const result = review?.result;
  const dependencyChanges = result?.dependencyChanges ?? [];
  const retainedDependencies = result?.retainedDependencies ?? [];
  const rejected = latest?.result.errors.length ? latest.result : null;
  return (
    <div className="schedule-paste-overlay">
      <section
        ref={dialog}
        className="schedule-paste-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="schedule-paste-title"
        aria-describedby={scopeLabel ? 'schedule-paste-project schedule-paste-description' : 'schedule-paste-description'}
        tabIndex={-1}
      >
        <header>
          <div>
            <h2 id="schedule-paste-title">
              {directLinks ? <Link2 size={21} /> : bulkDates ? <CalendarRange size={21} /> : <ClipboardList size={21} />}
              {title}
            </h2>
            {scopeLabel && <p id="schedule-paste-project">{scopeLabel}</p>}
            <p id="schedule-paste-description">
              {blockerLinks
                ? '차단하는 업무를 선행으로, 차단된 업무를 후행으로 연결합니다. 새 연결은 종료→시작(FS) · 0근무일이며 기존 연결은 유지합니다.'
                : bulkLinks
                ? '같은 프로젝트에서 기준 업무를 고르고 선택한 업무들과 맺을 관계를 확인하세요. 기존 연결은 유지합니다.'
                : bulkDates
                  ? '날짜별로 유지, 지정, 삭제를 고른 뒤 업무별 변경 내용을 확인하세요.'
                  : isTeamPaste
                    ? '여러 프로젝트의 업무 키와 함께 날짜 또는 선행 업무를 붙여넣고, 변경 내용을 확인한 뒤 적용하세요.'
                    : '현재 프로젝트의 업무 키와 함께 날짜 또는 선행 업무를 붙여넣고, 변경 내용을 확인한 뒤 적용하세요.'}
              {isTeamBlocker && ' 같은 프로젝트 안의 차단 관계를 선택하세요. 서로 다른 프로젝트의 업무는 간트의 프로젝트 간 차단에서 검토합니다.'}
            </p>
          </div>
          <button
            className="btn btn-ghost"
            type="button"
            aria-label={`${title} 닫기`}
            disabled={Boolean(pending)}
            onClick={close}
          >
            <X size={20} />
          </button>
        </header>

        <form className="schedule-paste-input" onSubmit={preview}>
          <fieldset disabled={editLocked}>
            {bulk && (
              <details className="schedule-bulk-targets">
                <summary>선택한 업무 {bulkIssues.length}개{projectCount !== undefined && ` · 프로젝트 ${projectCount}개`}</summary>
                <ul>
                  {bulkIssues.map(issue => (
                    <li key={issue.id}>
                      <span>{issue.key}</span> {issue.title}
                      <ScheduleProject project={selectedProjects?.get(issue.id)} />
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {Boolean(unavailableTargets?.length) && (
              <p className="schedule-paste-error" role="alert">
                선택한 업무가 삭제되었거나 다른 프로젝트로 이동했습니다. 간트에서 연결할 업무를 다시 선택해 주세요.
              </p>
            )}
            {blockerLinks ? (
              <GanttBlockerLinkPicker projectId={projectId} projects={blockerLinks.projects} projectFilterRef={blockerProjectFilter}
                issues={blockerIssuesById} dependencyFor={dependencyFor}
                selection={blockerSelection} refreshKey={blockerRefreshKey} onChange={updateBlockers} />
            ) : bulkLinks ? (
              <GanttBulkLinkFields anchors={anchors} anchor={anchor} searchRef={anchorSearch} query={anchorQuery}
                value={link} onSearch={setAnchorQuery} onChange={updateLink} />
            ) : bulkDates ? (
                <div className="schedule-bulk-date-fields">
                  {bulkFields.map(({ field, label }, index) => {
                    const entry = dates[field];
                    return (
                      <div key={field} className="schedule-bulk-date-field">
                        <label htmlFor={`schedule-bulk-${field}-action`}>{label}</label>
                        <select
                          ref={index === 0 ? firstDateAction : undefined}
                          id={`schedule-bulk-${field}-action`}
                          className="field"
                          aria-label={`${label} 변경`}
                          value={entry.action}
                          onChange={event => updateDate(field, { ...entry, action: event.target.value as DateAction })}
                        >
                          <option value="keep">유지</option>
                          <option value="set">지정</option>
                          <option value="clear">삭제</option>
                        </select>
                        {entry.action === 'set' && (
                          <input type="date" className="field" aria-label={`${label} 값`}
                            max="9999-12-31" required value={entry.value}
                            onChange={event => updateDate(field, { ...entry, value: event.target.value })} />
                        )}
                      </div>
                    );
                  })}
                </div>
            ) : (
              <>
                <label htmlFor="schedule-paste-text">일정표 (TSV 또는 CSV)</label>
                <textarea
                  ref={textarea}
                  id="schedule-paste-text"
                  className="field"
                  aria-label="붙여넣을 일정표"
                  aria-describedby="schedule-paste-help"
                  value={text}
                  onChange={(event) => updateText(event.target.value)}
                  placeholder={'key\tstartDate\tendDate\tdueDate\nPROJ-123\t2026-12-01\t2026-12-05\t2026-12-08'}
                  spellCheck={false}
                  rows={8}
                />
                <p id="schedule-paste-help">
                  시작일, 종료일, 목표 마감일은 YYYY-MM-DD로 입력하세요. 날짜 칸에 <code>-</code>를 입력하면 삭제되고,
                  빈 칸은 기존 날짜를 유지합니다.
                  선행 업무가 여러 개면 후행 업무 키를 연결마다 한 행씩 적으세요.
                  {isTeamPaste && ' 선후행 업무는 같은 프로젝트에 속해야 합니다.'}
                </p>
                <details className="schedule-paste-examples">
                  <summary>입력 예시 보기</summary>
                  <p>스프레드시트에서 헤더를 포함해 복사한 표는 탭으로 구분됩니다.</p>
                  <pre aria-label="TSV 일정 예시">
                    {'업무 키\t시작일\t종료일\t목표 마감일\t선행 업무\nPROJ-123\t2026-12-01\t2026-12-04\t2026-12-08\t\nPROJ-124\t2026-12-07\t2026-12-08\t-\tPROJ-123'}
                    {isTeamPaste && '\nOTHER-201\t2026-12-07\t2026-12-11\t2026-12-14\t'}
                  </pre>
                  <p>쉼표로 구분한 CSV도 사용할 수 있습니다.</p>
                  <pre aria-label="CSV 일정 예시">
                    {'key,startDate,endDate,dueDate\nPROJ-123,2026-12-01,2026-12-05,2026-12-08\nPROJ-124,,,-'}
                  </pre>
                  <p>
                    업무 키는 후행 업무를 가리킵니다. 같은 업무의 날짜는 서로 다른 행에 적을 수
                    있으며, 같은 날짜 열에 값을 여러 번 쓰면 값이 모두 같아야 합니다. 연결만 수정할 때는 날짜
                    열을 생략할 수 있습니다.
                  </p>
                  <pre aria-label="선행 업무 연결 예시">
                    {'업무 키\t선행 업무\t연결 유형\t근무일 간격\nPROJ-124\tPROJ-123\tSS\t2\nPROJ-124\tPROJ-122\tFS\t0\nPROJ-124\tPROJ-121\t-\t'}
                  </pre>
                  <p>
                    유형은 FS·SS·FF·SF를 지원합니다. 유형과 간격이 비어 있으면 기존 값을 유지하고, 새 연결은
                    FS·0근무일을 사용합니다. 선행 업무를 비워두면 연결을 유지합니다. 연결을 삭제하려면 해당
                    선행 업무를 지정하고 연결 유형에 <code>-</code>를 입력하세요.
                  </p>
                </details>
              </>
            )}
            {managed ? (
              <div className="schedule-bulk-date-actions">
                <button ref={pastePreviewButton} className="btn btn-primary" type="submit" disabled={!canPreview}>
                  {pending === 'preview' ? '검토 중…' : directLinks ? '연결 미리보기' : '날짜 변경 미리보기'}
                </button>
                <button className="btn" type="button" onClick={() => void reloadTargets()}>
                  <RefreshCw size={16} aria-hidden="true" /> 새로고침
                </button>
              </div>
            ) : (
              <button ref={pastePreviewButton} className="btn btn-primary" type="submit" disabled={!canPreview}>
                <RefreshCw size={16} />
                {pending === 'preview' ? '검토 중…' : '붙여넣기 미리보기'}
              </button>
            )}
          </fieldset>
        </form>

        <div className="schedule-paste-results">
          {pending && (
            <p className="schedule-paste-pending" role="status">
              <Loader2 className="spin" size={17} />
              {pending === 'preview' && blockerLinks ? '선택한 차단 관계의 선후행 연결을 검토하는 중입니다.'
                : pending === 'preview' && bulkLinks ? '선택한 업무의 선후행 연결을 검토하는 중입니다.'
                : pending === 'preview' && bulkDates ? '선택한 업무의 날짜를 검토하는 중입니다.' : pendingLabels[pending]}
            </p>
          )}
          {notice && <p className="schedule-paste-success" role="status">{notice}</p>}
          {error && (
            <p className="schedule-paste-error" role="alert">
              {error}
            </p>
          )}
          {retryApply && retryApply.input === input && (
            <p className="schedule-paste-stale">
              {preserveUnknownResult
                ? '같은 미리보기 ID로 적용 여부와 되돌리기 정보를 확인합니다.'
                : '같은 미리보기 ID로 다시 요청해 적용 여부와 되돌리기 정보를 확인합니다. 입력을 수정하거나 새 미리보기를 만들면 이 재시도는 초기화됩니다.'}
            </p>
          )}
          {applied && (
            <p className="schedule-paste-success" role="status">
              {directLinks ? `선후행 연결 ${applied.dependencyChanges ?? 0}건을 추가했습니다. `
                : bulkDates ? bulkDateResultMessage(applied.updated, team)
                  : `날짜 ${applied.updated.length}건과 업무 연결 ${applied.dependencyChanges ?? 0}건의 변경을 적용했습니다.`}
              적용 후 경고와 되돌리기는 간트에서 확인할 수 있습니다.
            </p>
          )}
          {rejected && (
            <section className="schedule-paste-rejected" aria-label={directLinks ? '선후행 연결 오류' : bulkDates ? '선택 업무 날짜 오류' : '일정 붙여넣기 오류'}>
              <h3>적용할 수 없는 입력 {rejected.errors.length}건</h3>
              <p>
                오류를 수정하고 미리보기를 다시 만드세요. 이전 변경안이 있으면 아래에 참고용으로 남겨
                둡니다.
              </p>
              <PagedList
                label={directLinks ? '선후행 연결 오류' : bulkDates ? '업무 날짜 오류' : '붙여넣기 오류'}
                items={rejected.errors}
                render={(item, index) => (
                  <li key={index}>
                    <strong>
                      {blockerLinks
                        ? blockerDiagnosticLabel(item)
                        : bulk
                        ? item.key || bulkIssues.find(issue => issue.id === item.issueId)?.key || '선택 업무'
                        : `${item.line === null ? '전체' : `${item.line}행`}${item.key ? ` · ${item.key}` : ''}`}
                    </strong>
                    {item.issueId && <ScheduleProject project={latest?.projects?.get(item.issueId)} />}
                    <span>{item.message}</span>
                  </li>
                )}
              />
            </section>
          )}
          {rejected && rejected.warnings.length > 0 && (
            <WarningList warnings={rejected.warnings} label="입력 검토 경고" />
          )}
          {result && (
            <section aria-label={directLinks ? '선후행 연결 변경 검토' : bulkDates ? '선택 업무 날짜 변경 검토' : '붙여넣기 변경 검토'}>
              <div className="schedule-paste-review-heading">
                <div>
                  <h3>
                    {directLinks ? `추가 ${dependencyChanges.length}건 · 유지 ${result.unchanged}건`
                      : bulkDates ? `변경 ${result.changes.length}개 · 유지 ${result.unchanged}개`
                        : `날짜 ${result.changes.length}건 · 업무 연결 ${dependencyChanges.length}건 · 유지 ${result.unchanged}행`}
                  </h3>
                  {result.projectIds && <p>대상 프로젝트 {result.projectIds.length}개</p>}
                  {result.expiresAt && (
                    <p>검토 유효 시간 {new Date(result.expiresAt).toLocaleTimeString('ko-KR')}까지</p>
                  )}
                </div>
                {result.previewId && (
                  <span className={`schedule-paste-approval ${validReview ? 'is-valid' : ''}`}>
                    {applied
                      ? '적용 완료'
                      : pending === 'apply'
                        ? '적용 중'
                        : pending === 'recover'
                          ? '결과 확인 중'
                          : pending === 'preview'
                            ? '검토 중'
                            : retryApply
                              ? '적용 결과 미확인'
                              : validReview
                                ? '적용 가능'
                                : expired
                                  ? '검토 만료'
                                  : '다시 검토 필요'}
                  </span>
                )}
              </div>
              {!validReview && hasChanges(result) && !applied && !pending && !retryApply && (
                <p className="schedule-paste-stale">
                  이전 검토 결과입니다. 현재 입력·업무 상태로 미리보기를 새로 만들어야 적용할 수
                  있습니다.
                </p>
              )}
              {!hasChanges(result) && (
                <p className="schedule-paste-noop">
                  {directLinks ? '추가할 선후행 연결이 없습니다.' : bulkDates ? '선택한 업무에서 바꿀 날짜가 없습니다.' : '변경할 날짜나 업무 연결이 없습니다.'}
                </p>
              )}
              {result.warnings.length > 0 && (
                <WarningList warnings={result.warnings} label="일정 검토 경고" />
              )}
              {result.changes.length > 0 && (
                <ChangeTable changes={result.changes} bulk={Boolean(bulkDates)} projects={review?.projects} teamProjects={teamProjects} />
              )}
              {dependencyChanges.length > 0 && (
                <DependencyChangeTable changes={dependencyChanges} mode={directLinks ? 'added' : 'paste'} teamProjects={teamProjects} />
              )}
              {directLinks && retainedDependencies.length > 0 && <DependencyChangeTable changes={retainedDependencies} mode="retained" teamProjects={teamProjects} />}
            </section>
          )}
        </div>

        <footer>
          <span>
            {applied
              ? '적용 후 간트에서 되돌리기를 사용할 수 있습니다.'
              : retryApply
                ? '적용 여부가 확인되지 않았습니다. 같은 요청의 결과를 확인하세요.'
                : directLinks ? '검토한 새 연결을 한 번에 추가합니다.'
                  : bulkDates ? '검토한 날짜만 한 번에 적용됩니다.' : '날짜와 업무 연결은 적용할 때 함께 변경됩니다.'}
          </span>
          <button className="btn btn-ghost" type="button" disabled={Boolean(pending)} onClick={close}>
            닫기
          </button>
          {applied ? (
            <button
              ref={applyRecoveryButton}
              className="btn btn-primary"
              type="button"
              disabled={Boolean(pending)}
              onClick={() => void retryReflection()}
            >
              적용 결과 화면에 반영
            </button>
          ) : retryApply && retryApply.input === input ? (
            <button
              ref={applyRecoveryButton}
              className="btn btn-primary"
              type="button"
              disabled={Boolean(pending)}
              onClick={() => void requestApply(retryApply.previewId, retryApply.input, true)}
            >
              적용 결과 다시 확인
            </button>
          ) : (
            <button
              className="btn btn-primary"
              type="button"
              disabled={Boolean(pending) || !validReview}
              onClick={() => void apply()}
            >
              <Check size={16} />
              {directLinks ? '검토한 연결 적용' : '검토한 일정 적용'}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

function DateResult({ before, after }: { before: string | null; after: string | null }) {
  const action = before === after ? '유지' : after === null ? '삭제' : before === null ? '추가' : '변경';
  return (
    <span
      className={`schedule-paste-date is-${action === '삭제' ? 'removed' : action === '유지' ? 'unchanged' : 'changed'}`}
    >
      <strong>{after || '미정'}</strong>
      <small>{action}</small>
    </span>
  );
}

function ScheduleProject({ project }: { project?: ProjectName }) {
  return project ? <small className="schedule-bulk-project" data-schedule-project={project.id}>{project.name}</small> : null;
}

function ChangeTable({ changes, bulk, projects, teamProjects }: {
  changes: SchedulePastePreview['changes']; bulk: boolean; projects?: ProjectLabels; teamProjects?: ProjectLabels;
}) {
  const [offset, setOffset] = useState(0);
  const start = Math.min(offset, Math.max(0, Math.floor((changes.length - 1) / PAGE_SIZE) * PAGE_SIZE));
  const showDueDate = !bulk && changes.some(hasDueDateChange);
  return (
    <div className={`schedule-paste-change-table${bulk ? ' schedule-bulk-date-table' : ''}`}>
      <div className="schedule-paste-table-scroll" tabIndex={showDueDate ? 0 : undefined}
        role={showDueDate ? 'region' : undefined} aria-label={showDueDate ? '일정 변경 표 스크롤' : undefined}>
        <table aria-label={bulk ? '선택 업무 날짜 변경 목록' : '붙여넣기 일정 변경 목록'}>
          <thead>
            <tr>
              <th scope="col">업무</th>
              {bulk ? bulkFields.map(({ field, label }) => <th key={field} scope="col">{label}</th>) : (
                <>
                  <th scope="col">현재 시작일</th>
                  <th scope="col">변경 시작일</th>
                  <th scope="col">현재 종료일</th>
                  <th scope="col">변경 종료일</th>
                  {showDueDate && <th scope="col">목표 마감일</th>}
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {changes.slice(start, start + PAGE_SIZE).map((change) => (
              <tr key={change.id}>
                <th scope="row">
                  <small>{change.key}</small>
                  <strong>{change.title}</strong>
                  <ScheduleProject project={projects?.get(change.id) ?? (change.projectId ? teamProjects?.get(change.projectId) : undefined)} />
                </th>
                {bulk ? (
                  <>
                    <DateChangeCell before={change.fromStart} after={change.toStart} />
                    <DateChangeCell before={change.fromEnd} after={change.toEnd} />
                    <DateChangeCell before={change.fromDue ?? null} after={change.toDue ?? null} />
                  </>
                ) : (
                  <>
                    <td>{change.fromStart || '미정'}</td>
                    <td><DateResult before={change.fromStart} after={change.toStart} /></td>
                    <td>{change.fromEnd || '미정'}</td>
                    <td><DateResult before={change.fromEnd} after={change.toEnd} /></td>
                    {showDueDate && (hasDueDateChange(change)
                      ? <DateChangeCell before={change.fromDue ?? null} after={change.toDue ?? null} /> : <td />)}
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {changes.length > PAGE_SIZE && (
        <Pagination label="일정 변경" offset={start} total={changes.length} onChange={setOffset} />
      )}
    </div>
  );
}

function DateChangeCell({ before, after }: { before: string | null; after: string | null }) {
  return (
    <td className="schedule-paste-date-change">
      {before !== after && <span className="schedule-paste-date-previous">{before || '미정'} →</span>}
      <DateResult before={before} after={after} />
    </td>
  );
}

function DependencyChangeTable({ changes, mode, teamProjects }: {
  changes: SchedulePasteDependencyChange[]; mode: 'paste' | 'added' | 'retained'; teamProjects?: ProjectLabels;
}) {
  const [offset, setOffset] = useState(0);
  const start = Math.min(offset, Math.max(0, Math.floor((changes.length - 1) / PAGE_SIZE) * PAGE_SIZE));
  const label = mode === 'retained' ? '유지할 선후행 연결 목록' : mode === 'added' ? '새 선후행 연결 목록' : '붙여넣기 업무 연결 변경 목록';
  return (
    <div className="schedule-paste-change-table schedule-paste-dependency-table">
      {mode !== 'paste' && <h4>{label}</h4>}
      <table aria-label={label}>
        <thead>
          <tr>
            <th scope="col">선행 → 후행 업무</th>
            <th scope="col">{mode === 'retained' ? '유지할 연결' : '현재 연결'}</th>
            {mode !== 'retained' && <th scope="col">{mode === 'added' ? '추가할 연결' : '변경할 연결'}</th>}
          </tr>
        </thead>
        <tbody>
          {changes.slice(start, start + PAGE_SIZE).map((change) => (
            <tr key={change.line}>
              <th scope="row">
                {mode === 'paste' && <small>입력 {change.line}행</small>}
                {change.projectId && <ScheduleProject project={teamProjects?.get(change.projectId)} />}
                <small>{change.predecessorKey}</small>
                <strong>{change.predecessorTitle}</strong>
                <ArrowDown className="schedule-paste-dependency-arrow" aria-hidden="true" size={14} />
                <small>{change.successorKey}</small>
                <strong>{change.successorTitle}</strong>
              </th>
              <td><DependencyRule rule={change.before} action={mode === 'retained' ? '유지' : undefined} /></td>
              {mode !== 'retained' && <td>
                <DependencyRule rule={change.after}
                  action={!change.after ? '삭제' : !change.before ? '추가' : '변경'} />
              </td>}
            </tr>
          ))}
        </tbody>
      </table>
      {changes.length > PAGE_SIZE && (
        <Pagination label={mode === 'paste' ? '업무 연결 변경' : label} offset={start} total={changes.length} onChange={setOffset} />
      )}
    </div>
  );
}

function DependencyRule({ rule, action }: {
  rule: SchedulePasteDependencyChange['before'];
  action?: '추가' | '변경' | '삭제' | '유지';
}) {
  return (
    <span className={`schedule-paste-dependency-rule${action && action !== '유지' ? rule ? ' is-changed' : ' is-removed' : ''}`}>
      {rule ? (
        <>
          <strong>{rule.type} · {DEPENDENCY_LABELS[rule.type]}</strong>
          <span>{rule.lagDays > 0 ? '+' : ''}{rule.lagDays}근무일</span>
        </>
      ) : <strong>연결 없음</strong>}
      {action && <small>{action}</small>}
    </span>
  );
}

function WarningList({ warnings, label }: { warnings: string[]; label: string }) {
  return (
    <section className="schedule-paste-warnings" aria-label={label}>
      <h4>
        {label} {warnings.length}건
      </h4>
      <PagedList
        label={label}
        items={warnings}
        render={(warning, index) => <li key={index}>{warning}</li>}
      />
    </section>
  );
}

function PagedList<T>({
  label,
  items,
  render,
}: {
  label: string;
  items: T[];
  render: (item: T, index: number) => ReactNode;
}) {
  const [offset, setOffset] = useState(0);
  const start = Math.min(offset, Math.max(0, Math.floor((items.length - 1) / PAGE_SIZE) * PAGE_SIZE));
  return (
    <>
      <ul>{items.slice(start, start + PAGE_SIZE).map(render)}</ul>
      {items.length > PAGE_SIZE && (
        <Pagination label={label} offset={start} total={items.length} onChange={setOffset} />
      )}
    </>
  );
}

function Pagination({
  label,
  offset,
  total,
  onChange,
}: {
  label: string;
  offset: number;
  total: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="schedule-paste-pagination">
      <span>
        {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} / {total}
      </span>
      <button
        className="btn btn-ghost"
        type="button"
        aria-label={`${label} 이전 페이지`}
        disabled={offset === 0}
        onClick={() => onChange(Math.max(0, offset - PAGE_SIZE))}
      >
        이전
      </button>
      <button
        className="btn btn-ghost"
        type="button"
        aria-label={`${label} 다음 페이지`}
        disabled={offset + PAGE_SIZE >= total}
        onClick={() => onChange(offset + PAGE_SIZE)}
      >
        다음
      </button>
    </div>
  );
}
