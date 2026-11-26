'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowDown, CalendarRange, Check, ClipboardList, Link2, Loader2, RefreshCw, X } from 'lucide-react';
import { MAX_WORKING_DURATION_DAYS } from '../../shared/calendar';
import { DEPENDENCY_LABELS, isDependencyLag } from '../../shared/schedule-dependencies';
import { MAX_SCHEDULE_BLOCKER_LINKS, MAX_SCHEDULE_BULK_LINK_ISSUES } from '../../shared/types';
import type {
  Dependency, FeatureProps, Issue, Project, ScheduleBlockerLinkInput, ScheduleBulkDateChanges, ScheduleBulkDateInput,
  ScheduleBulkChainInput, ScheduleBulkLinkAction, ScheduleBulkLinkDateEdit, ScheduleBulkLinkInput, ScheduleChange, SchedulePasteApplyResult,
  SchedulePasteDependencyChange, SchedulePasteDependencyPair, SchedulePastePreview, ScheduleSheetChoices, ScheduleUndoScope, TeamScheduleBlocker, WorkspaceSnapshot,
} from '../../shared/types';
import { issueSearchAliasLabel } from '../../shared/workspace-search';
import { api, ApiError } from '../lib/api';
import { GanttBlockerLinkPicker, type BlockerLinkSelection } from './GanttBlockerLinksDialog';
import {
  bulkLinkDateFields, GanttBulkChainFields, GanttBulkLinkDateFields, GanttBulkLinkFields,
  type BulkLinkDateChoice, type BulkLinkDateField, type BulkLinkDateRow, type BulkLinkDraft,
  type BulkLinkOperation, type BulkLinkRule, type BulkLinkRuleChanges,
} from './GanttBulkLinksDialog';
import { scheduleUndoHeaders } from './schedule-undo';
import './schedule-paste.css';

type BulkDates = {
  issues: readonly Issue[];
  projects: readonly Project[];
  dateDrafts?: readonly BulkLinkDateDraft[];
  clipboard?: { unavailableKeys: readonly string[] };
  refresh: () => Promise<void>;
};
export type BulkLinkDateDraft = {
  source: Pick<Issue, 'id' | 'version' | 'projectId' | 'startDate' | 'endDate'>;
  changes: ScheduleBulkDateChanges;
};
type BulkLinks = {
  issues: readonly Issue[];
  candidates: readonly Issue[];
  issueAliases?: WorkspaceSnapshot['issueAliases'];
  dateDrafts?: readonly BulkLinkDateDraft[];
  refresh: () => Promise<void>;
};
type BlockerLinks = { issues: readonly Issue[]; dependencies: readonly Dependency[]; projects?: readonly Project[]; refresh: () => Promise<void> };
type TeamPaste = { projects: readonly Project[] };
type ProjectName = Pick<Project, 'id' | 'name'>;
type ProjectLabels = ReadonlyMap<string, ProjectName>;

export type SchedulePasteDialogProps = {
  actorId: string;
  undoScope: ScheduleUndoScope;
  workspaceProjects?: readonly Project[];
  notify: FeatureProps['notify'];
  onClose: (awaitingResult?: boolean) => void;
  onDraftChange: (id: string, dirty: boolean, pending?: boolean, awaitingResult?: boolean) => void;
  onApplied: (result: SchedulePasteApplyResult, linkOperation: BulkLinkOperation,
    reviewedDateDrafts?: readonly ScheduleBulkLinkDateEdit[]) => Promise<void>;
} & (
  | { projectId: string; projectLabel?: string; bulkDates?: never; bulkLinks?: BulkLinks; blockerLinks?: never; teamPaste?: never }
  | { projectId: string | null; projectLabel?: string; bulkDates?: never; bulkLinks?: never; blockerLinks: BlockerLinks; teamPaste?: never }
  | { projectId: string | null; projectLabel?: never; bulkDates: BulkDates; bulkLinks?: never; blockerLinks?: never; teamPaste?: never }
  | { projectId: null; projectLabel?: never; bulkDates?: never; bulkLinks?: never; blockerLinks?: never; teamPaste: TeamPaste }
);

type Review = {
  input: string;
  targets: string;
  projects?: ProjectLabels;
  result: SchedulePastePreview;
  linkOperation: BulkLinkOperation;
  reviewedDateDrafts?: readonly ScheduleBulkLinkDateEdit[];
};
type DateDraftChoices = Partial<Record<BulkLinkDateField, { saved: string | null; choice: BulkLinkDateChoice }>>;
type DateField = 'startDate' | 'endDate' | 'dueDate';
type DateAction = 'keep' | 'set' | 'clear' | 'workdays';
type DateEntry = { action: DateAction; value: string };
type DateDraft = Record<DateField, DateEntry>;
type LinkMode = 'anchor' | 'chain';
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
const defaultLinkRule: BulkLinkRule = { type: 'FS', lagDays: '0' };
const defaultLink: BulkLinkDraft = { ...defaultLinkRule, choice: null, direction: 'predecessor' };
const linkOperationLabels = { add: '추가', update: '수정', remove: '해제' } as const;
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

export function bulkLinkResultMessage(count: number, operation: BulkLinkOperation) {
  return `선후행 연결 ${count}건을 ${linkOperationLabels[operation]}했습니다.`;
}

function bulkLinkAction(operation: BulkLinkOperation, rule: BulkLinkRule, changes: BulkLinkRuleChanges): ScheduleBulkLinkAction | null {
  if (operation === 'remove') return { operation };
  const lagDays = rule.lagDays.trim() ? Number(rule.lagDays) : NaN;
  const validLag = isDependencyLag(lagDays);
  if (operation === 'add') return validLag ? { type: rule.type, lagDays } : null;
  if ((!changes.type && !changes.lagDays) || (changes.lagDays && !validLag)) return null;
  return { operation, ...(changes.type ? { type: rule.type } : {}), ...(changes.lagDays ? { lagDays } : {}) };
}

function ProjectScheduleEditDialog({
  actorId,
  undoScope,
  projectId,
  projectLabel,
  workspaceProjects,
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
  const [sheetChoices, setSheetChoices] = useState<ScheduleSheetChoices>({});
  const [rescheduleSuccessors, setRescheduleSuccessors] = useState(false);
  const [includeTeamBlockers, setIncludeTeamBlockers] = useState(false);
  const [dates, setDates] = useState<DateDraft>({ startDate: keepDate, endDate: keepDate, dueDate: keepDate });
  const [workingDays, setWorkingDays] = useState('3');
  const [link, setLink] = useState<BulkLinkDraft>(defaultLink);
  const [linkOperation, setLinkOperation] = useState<BulkLinkOperation>('add');
  const [linkRuleChanges, setLinkRuleChanges] = useState<BulkLinkRuleChanges>({ type: false, lagDays: false });
  const [linkMode, setLinkMode] = useState<LinkMode>(() => {
    const selected = new Set(bulkLinks?.issues.map(issue => issue.id));
    return bulkLinks?.candidates.some(issue => issue.projectId === projectId && !selected.has(issue.id)) ? 'anchor' : 'chain';
  });
  const [chainOrder, setChainOrder] = useState(() => bulkLinks?.issues.map(issue => issue.id) ?? []);
  const [chainRule, setChainRule] = useState<BulkLinkRule>(defaultLinkRule);
  const [anchorQuery, setAnchorQuery] = useState('');
  const [excludedDateDrafts, setExcludedDateDrafts] = useState<ReadonlySet<string>>(() => new Set());
  const [dateDraftChoices, setDateDraftChoices] = useState<ReadonlyMap<string, DateDraftChoices>>(() => new Map());
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
  const linkModeSelect = useRef<HTMLSelectElement>(null);
  const blockerProjectFilter = useRef<HTMLSelectElement>(null);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const dirtyRef = useRef(false);
  const request = useRef<AbortController | null>(null);
  const formId = useId();

  const bulk = bulkDates ?? bulkLinks;
  const clipboard = bulkDates?.clipboard;
  const bulkIssues = bulk?.issues ?? [];
  const managed = bulk ?? blockerLinks;
  const blockerDialog = Boolean(blockerLinks);
  const directLinks = Boolean(bulkLinks || blockerLinks);
  const isTeamPaste = Boolean(teamPaste);
  const isTeamBlocker = projectId === null && blockerDialog;
  const focusTeamRecovery = isTeamPaste || isTeamBlocker;
  const focusApplyRecovery = focusTeamRecovery || Boolean(clipboard);
  const preserveUnknownResult = Boolean(managed || teamPaste);
  const reportUnknownResult = directLinks || isTeamPaste || Boolean(bulkDates);
  const draftId = blockerLinks ? BLOCKER_LINK_DRAFT_ID : bulkLinks ? BULK_LINK_DRAFT_ID : bulkDates ? BULK_DRAFT_ID : SCHEDULE_PASTE_DRAFT_ID;
  const team = projectId === null;
  const scopeLabel = focusTeamRecovery ? '전체 프로젝트' : projectLabel ? `대상 프로젝트 ${projectLabel}` : undefined;
  const linkOperationLabel = linkOperationLabels[linkOperation];
  const title = blockerLinks ? '차단 관계 선후행 검토'
    : bulkLinks ? `선후행 연결 일괄 ${linkOperationLabel}` : clipboard ? '붙여넣은 날짜 검토' : bulkDates ? '일정 일괄 편집' : '일정 붙여넣기';
  const datesEdited = bulkFields.some(({ field }) => dates[field].action !== 'keep');
  const durationEndpoint = dates.startDate.action === 'workdays' ? 'startDate' : dates.endDate.action === 'workdays' ? 'endDate' : null;
  const workdayDuration: ScheduleBulkDateInput['workdayDuration'] | null =
    durationEndpoint && { endpoint: durationEndpoint, workingDays: Number(workingDays) };
  const durationValid = !workdayDuration || Number.isSafeInteger(workdayDuration.workingDays) &&
    workdayDuration.workingDays >= 1 && workdayDuration.workingDays <= MAX_WORKING_DURATION_DAYS;
  const chainMode = linkMode === 'chain';
  const chainEdited = chainRule.type !== defaultLinkRule.type || chainRule.lagDays !== defaultLinkRule.lagDays ||
    chainOrder.some((id, index) => id !== bulkIssues[index]?.id);
  const linkRuleEdited = hasLinkInput(link, anchorQuery) || chainEdited;
  const dateDraftChoicesEdited = excludedDateDrafts.size > 0 || dateDraftChoices.size > 0;
  const bulkDateInputsEdited = Boolean(clipboard) || datesEdited || dateDraftChoicesEdited || rescheduleSuccessors;
  const linkPreferencesEdited = rescheduleSuccessors || linkOperation !== 'add';
  const linksEdited = linkRuleEdited || dateDraftChoicesEdited || linkPreferencesEdited;
  const linkAction = bulkLinkAction(linkOperation, chainMode ? chainRule : link, linkRuleChanges);
  const selectedBlockers = [...blockerSelection.values()];
  const blockerInput: ScheduleBlockerLinkInput | null = blockerLinks
    ? projectId === null ? {
      projectId: null,
      relations: selectedBlockers.flatMap(relation => relation.projectId
        ? [{ id: relation.id, version: relation.version, projectId: relation.projectId }] : []),
    } : { projectId, relations: selectedBlockers.map(({ id, version }) => ({ id, version })) }
    : null;
  const issues = bulkIssues.map(issue => ({ id: issue.id, expectedVersion: issue.version }));
  const selectedIds = new Set(issues.map(issue => issue.id));
  const sameProjectCandidates = bulkLinks?.candidates.filter(issue => issue.projectId === projectId) ?? [];
  const sameProjectIds = new Set(sameProjectCandidates.map(issue => issue.id));
  const unavailableTargets = bulkLinks && bulkIssues.filter(issue => issue.projectId !== projectId || !sameProjectIds.has(issue.id));
  const anchors = sameProjectCandidates.filter(issue => !selectedIds.has(issue.id));
  const anchor = chainMode ? undefined : anchors.find(issue => issue.id === link.choice?.id);
  const bulkIssuesById = new Map(bulkIssues.map(issue => [issue.id, issue]));
  const chainIssues = chainOrder.map(id => bulkIssuesById.get(id)).filter((issue): issue is Issue => Boolean(issue));
  const dateDrafts = bulkDates?.dateDrafts ?? bulkLinks?.dateDrafts;
  const dateDraftsById = useMemo(() => new Map(dateDrafts?.map(draft => [draft.source.id, draft])), [dateDrafts]);
  const dateDraftRows: BulkLinkDateRow[] = [];
  const dateDraftEdits: ScheduleBulkLinkDateEdit[] = [];
  const reviewedDateDrafts: ScheduleBulkLinkDateEdit[] = [];
  let hasConflictingDateDrafts = false;
  const dateDraftIssues = bulkDates ? bulkIssues : chainMode ? chainIssues : anchor ? [...bulkIssues, anchor] : bulkIssues;
  for (const issue of dateDraftIssues) {
    const dateDraft = dateDraftsById.get(issue.id);
    if (!dateDraft || dateDraft.source.projectId !== issue.projectId || (bulkLinks && !sameProjectIds.has(issue.id))) continue;
    const changedDates: BulkLinkDateRow['dates'] = [];
    const changes: ScheduleBulkDateChanges = {};
    const reviewedDates: ScheduleBulkDateChanges = {};
    for (const field of bulkLinkDateFields) {
      const draft = dateDraft.changes[field];
      if (draft === undefined) continue;
      const base = dateDraft.source[field] ?? null;
      const saved = issue[field] ?? null;
      const decision = dateDraftChoices.get(issue.id)?.[field];
      const conflict = saved !== draft && (saved !== base || decision !== undefined);
      const choice = decision && decision.saved === saved ? decision.choice : undefined;
      changedDates.push({ field, base, saved, draft, conflict, choice });
      const value = choice === 'saved' ? saved : draft;
      reviewedDates[field] = value;
      // In a shared date edit, keeping the saved value overrides the corresponding common change.
      if (bulkDates || saved !== value) changes[field] = value;
    }
    if (!changedDates.length) continue;
    dateDraftRows.push({ issue, dates: changedDates });
    if (excludedDateDrafts.has(issue.id)) continue;
    if (changedDates.some(date => date.conflict && !date.choice)) {
      hasConflictingDateDrafts = true;
      continue;
    }
    const target = { id: issue.id, expectedVersion: issue.version };
    reviewedDateDrafts.push({ issue: target, changes: reviewedDates });
    if (Object.keys(changes).length) dateDraftEdits.push({ issue: target, changes });
  }
  const hasDateDraftEdits = dateDraftEdits.length > 0;
  const editsLinkDates = Boolean(bulkLinks && hasDateDraftEdits);
  const rowDatesInput = hasDateDraftEdits ? { dates: dateDraftEdits } : {};
  const followUpInput = rescheduleSuccessors ? { rescheduleSuccessors: true as const } : {};
  const teamFollowUpInput = includeTeamBlockers && rescheduleSuccessors ? { includeTeamBlockers: true as const } : {};
  const sheetChoiceInput = Object.keys(sheetChoices).length ? { sheetChoices } : {};
  const reviewChoices = [[...excludedDateDrafts], [...dateDraftChoices], rescheduleSuccessors, includeTeamBlockers];
  const input = blockerInput ? JSON.stringify(blockerInput)
    : bulkLinks ? JSON.stringify([chainMode
      ? [linkMode, chainOrder]
      : [linkMode, link.choice?.id, link.direction],
      linkAction, ...reviewChoices])
      : bulkDates ? JSON.stringify([dates, durationEndpoint ? workingDays : null, ...reviewChoices])
        : JSON.stringify([text, rescheduleSuccessors, includeTeamBlockers, sheetChoices]);
  const linkRulesValid = projectId !== null && !unavailableTargets?.length && !hasConflictingDateDrafts &&
    issues.length >= 2 && issues.length <= MAX_SCHEDULE_BULK_LINK_ISSUES;
  const bulkLinkInput: ScheduleBulkLinkInput | null = anchor && linkRulesValid && linkAction
    ? { projectId, issues, anchor: { id: anchor.id, expectedVersion: anchor.version }, direction: link.direction,
      ...linkAction, ...rowDatesInput, ...followUpInput, ...teamFollowUpInput }
    : null;
  const bulkChainInput: ScheduleBulkChainInput | null = bulkLinks && chainMode && linkRulesValid && linkAction && chainIssues.length === issues.length
    ? { mode: 'chain', projectId, issues: chainIssues.map(issue => ({ id: issue.id, expectedVersion: issue.version })),
      ...linkAction, ...rowDatesInput, ...followUpInput, ...teamFollowUpInput }
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
  const teamProjectList = team ? bulkDates?.projects ?? teamPaste?.projects ?? blockerLinks?.projects : undefined;
  const teamProjects = teamProjectList && new Map(teamProjectList.map(project => [project.id, {
    id: project.id, name: bulkDates ? project.name : `${project.key} · ${project.name}`,
  }]));
  const dateChangeProjects = teamProjects ?? (workspaceProjects && projectId !== null
    ? new Map(workspaceProjects.filter(project => project.id !== projectId).map(project => [project.id, project]))
    : undefined);
  const projectCount = selectedProjects ? new Set([...selectedProjects.values()].map(project => project.id)).size : undefined;
  const canPreview = blockerInput
    ? selectedBlockers.length > 0 && selectedBlockers.length <= MAX_SCHEDULE_BLOCKER_LINKS &&
      blockerInput.relations.length === selectedBlockers.length
    : bulkLinks
    ? Boolean(bulkLinkInput || bulkChainInput)
    : bulkDates
      ? issues.length > 0 && (datesEdited || hasDateDraftEdits) && durationValid && !hasConflictingDateDrafts && !clipboard?.unavailableKeys.length &&
        bulkFields.every(({ field }) => dates[field].action !== 'set' || dates[field].value)
      : Boolean(text.trim());
  const editLocked = Boolean(pending || applied || (preserveUnknownResult && retryApply));
  const dirty = !applied && Boolean((blockerLinks ? blockerSelection.size
    : bulkLinks ? linksEdited : bulkDates ? bulkDateInputsEdited : text || rescheduleSuccessors) || review || latest || error);
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
    (blockerProjectFilter.current ?? anchorSearch.current ?? linkModeSelect.current ?? firstDateAction.current ?? textarea.current ??
      pastePreviewButton.current ?? dialog.current)?.focus({ preventScroll: true });
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
    if (!focusApplyRecovery || pending) return;
    if (retryApply || applied) {
      applyRecoveryButton.current?.focus({ preventScroll: true });
    } else if (error) {
      const active = document.activeElement;
      if (!dialog.current?.contains(active) || active?.matches(':disabled')) pastePreviewButton.current?.focus();
    }
  }, [applied, error, focusApplyRecovery, pending, retryApply]);

  const close = useCallback(() => {
    if (busyRef.current) {
      notify('일정 요청 결과를 확인한 뒤 닫아 주세요.', 'error');
      return;
    }
    let confirmation = '붙여넣은 일정과 검토 결과를 버리고 닫을까요?';
    if (directLinks) confirmation = retryApply
      ? '연결 변경이 이미 적용됐을 수 있습니다. 적용 결과 확인을 닫을까요?'
      : blockerLinks
        ? '선택한 차단 관계와 검토 결과를 버리고 닫을까요?'
        : '입력한 선후행 연결과 검토 결과를 버리고 닫을까요?';
    else if (bulkDates || (isTeamPaste && retryApply)) confirmation = retryApply
      ? '일정이 이미 변경됐을 수 있습니다. 적용 결과 확인을 닫을까요?'
      : '입력한 날짜와 검토 결과를 버리고 닫을까요?';
    if (dirtyRef.current && !window.confirm(confirmation)) return;
    dirtyRef.current = false;
    onDraftChange(draftId, false, false);
    if ((focusTeamRecovery || bulkDates) && retryApply) onClose(true);
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
    dirtyRef.current = edited || Boolean(clipboard || review);
    onDraftChange(draftId, dirtyRef.current, false);
  }

  function updateText(value: string) {
    setText(value);
    setSheetChoices({});
    resetReview(Boolean(value || rescheduleSuccessors));
  }

  function updateSheetChoice(id: string, choice: string) {
    const next = { ...sheetChoices };
    if (choice === 'current' || choice === 'input') next[id] = choice;
    else delete next[id];
    setSheetChoices(next);
    setApproved(false);
    setRetryApply(null);
    setError('');
    setNotice('');
  }

  function updateSuccessorReview(value: boolean) {
    setRescheduleSuccessors(value);
    if (!value) setIncludeTeamBlockers(false);
    const edited = bulkLinks ? linkRuleEdited || dateDraftChoicesEdited || linkOperation !== 'add'
      : bulkDates ? datesEdited || dateDraftChoicesEdited : Boolean(text);
    resetReview(edited || value);
  }

  function updateDate(field: DateField, entry: DateEntry) {
    const next = { ...dates, [field]: entry };
    setDates(next);
    resetReview(bulkFields.some(item => next[item.field].action !== 'keep') || dateDraftChoicesEdited || rescheduleSuccessors);
  }

  function updateLink(next: BulkLinkDraft) {
    setLink(next);
    resetReview(hasLinkInput(next, anchorQuery) || chainEdited || dateDraftChoicesEdited || linkPreferencesEdited);
  }

  function updateLinkOperation(next: BulkLinkOperation) {
    setLinkOperation(next);
    resetReview(linkRuleEdited || dateDraftChoicesEdited || rescheduleSuccessors || next !== 'add');
  }

  function updateLinkRuleChanges(next: BulkLinkRuleChanges) {
    setLinkRuleChanges(next);
    resetReview(true);
  }

  function updateLinkMode(next: LinkMode) {
    setLinkMode(next);
    resetReview(linksEdited);
  }

  function moveChainIssue(from: number, to: number) {
    const next = [...chainOrder];
    [next[from], next[to]] = [next[to], next[from]];
    setChainOrder(next);
    resetReview(true);
  }

  function updateChainRule(next: BulkLinkRule) {
    setChainRule(next);
    resetReview(true);
  }

  function updateDateDraftInclusion(id: string, include: boolean) {
    const excluded = new Set(excludedDateDrafts);
    if (include) excluded.delete(id);
    else excluded.add(id);
    setExcludedDateDrafts(excluded);
    const choices = new Map(dateDraftChoices);
    if (!include) choices.delete(id);
    setDateDraftChoices(choices);
    resetReview(excluded.size > 0 || choices.size > 0 || (bulkDates ? datesEdited || rescheduleSuccessors : linkRuleEdited || linkPreferencesEdited));
  }

  function chooseDateDraft(id: string, field: BulkLinkDateField, saved: string | null, choice: BulkLinkDateChoice) {
    const choices = new Map(dateDraftChoices);
    choices.set(id, { ...choices.get(id), [field]: { saved, choice } });
    setDateDraftChoices(choices);
    resetReview(true);
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
    const submitted = { input, targets, projects: selectedProjects, linkOperation, reviewedDateDrafts };
    let payload: { projectId: string | null; text: string; rescheduleSuccessors?: true; includeTeamBlockers?: true; sheetChoices?: ScheduleSheetChoices } |
      ScheduleBulkDateInput | ScheduleBulkLinkInput |
      ScheduleBulkChainInput | ScheduleBlockerLinkInput;
    if (blockerInput) payload = blockerInput;
    else if (bulkLinkInput) payload = bulkLinkInput;
    else if (bulkChainInput) payload = bulkChainInput;
    else if (bulkDates) {
      const changes: ScheduleBulkDateChanges = {};
      for (const { field } of bulkFields) {
        const { action, value } = dates[field];
        if (action === 'clear') changes[field] = null;
        else if (action === 'set') changes[field] = value;
      }
      payload = { projectId, issues, changes, ...rowDatesInput, ...followUpInput, ...teamFollowUpInput,
        ...(workdayDuration ? { workdayDuration } : {}) };
    } else payload = { projectId, text, ...followUpInput, ...teamFollowUpInput, ...sheetChoiceInput };
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
      if (sheetChoiceInput.sheetChoices) {
        const currentIds = new Set(result.sheetConflicts?.map(conflict => conflict.id));
        const currentChoices = Object.entries(sheetChoices).filter(([id]) => currentIds.has(id));
        if (currentChoices.length !== Object.keys(sheetChoices).length) setSheetChoices(Object.fromEntries(currentChoices));
      }
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
    const inputLabel = bulkLinks
      ? dateDraftRows.length ? '선택한 업무와 연결 입력, 날짜 초안' : '선택한 업무와 연결 입력'
      : dateDraftRows.length ? '선택한 업무와 날짜 입력, 날짜 초안' : '선택한 업무와 날짜 입력';
    try {
      await managed.refresh();
      if (!mounted.current || controller.signal.aborted) return;
      setLatest(null);
      if (blockerLinks) {
        setBlockerRefreshKey(value => value + 1);
        setNotice('차단 관계 선택을 유지했습니다. 변경된 관계는 다시 선택한 뒤 연결 미리보기를 만들어 주세요.');
      } else setNotice(`${inputLabel}을 유지했습니다. 최신 업무 상태로 미리보기를 다시 만들어 주세요.`);
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) {
        const kept = blockerLinks ? '차단 관계 선택' : inputLabel;
        setError(`${errorMessage(cause)} ${kept}은 유지했습니다.`);
      }
    } finally {
      finish(controller);
    }
  }

  async function reflectResult(result: SchedulePasteApplyResult) {
    try {
      await onApplied(result, review?.linkOperation ?? linkOperation, review?.reviewedDateDrafts);
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
  const reviewedLinkDates = Boolean(bulkLinks && result?.changes.length);
  const mixedLinkReview = editsLinkDates || reviewedLinkDates;
  const followUpIssues = new Set(result?.followUpIssueIds);
  const appliedFollowUpCount = applied?.updated.filter(issue => followUpIssues.has(issue.id)).length ?? 0;
  const dependencyChanges = result?.dependencyChanges ?? [];
  const retainedDependencies = result?.retainedDependencies ?? [];
  const missingDependencies = result?.missingDependencies ?? [];
  const reviewedOperation = review?.linkOperation ?? linkOperation;
  const reviewedOperationLabel = linkOperationLabels[reviewedOperation];
  const keyMappings = result?.keyMappings ?? [];
  const rejected = latest?.result.errors.length ? latest.result : null;
  const sheetConflicts = latest?.result.sheetConflicts ?? [];
  const inputErrors = rejected?.errors.filter(item => !item.sheetConflictId) ?? [];
  const rejectedMissingDependencies = rejected?.missingDependencies ?? [];
  const linkDescription = chainMode
    ? '목록에서 연이어 배치한 두 업무가 연결 대상입니다.'
    : '같은 프로젝트에서 기준 업무를 고르고 선택한 업무들과의 연결 방향을 지정하세요.';
  const linkInstructions = {
    add: '새 연결의 유형과 간격을 지정하세요.',
    update: '기존 연결에서 수정할 항목을 하나 이상 선택하세요.',
    remove: '선택한 방향의 기존 연결을 검토한 뒤 해제하세요.',
  }[linkOperation];
  const followUpDescription = bulkLinks
    ? linkOperation === 'remove'
      ? '직접 바꾼 시작일과 종료일을 유지합니다. 남은 연결을 기준으로 후행 업무를 필요한 만큼 늦춥니다.'
      : '직접 바꾼 시작일과 종료일을 유지합니다. 연결과 날짜가 영향을 주는 후행 업무는 현재 보기에 없어도 필요한 만큼 늦춥니다.'
    : '직접 바꾼 시작일과 종료일을 유지합니다. 각 프로젝트의 선후행 연결에 맞춰 후행 일정을 필요한 만큼 늦춥니다.';
  const followUpOption = (
    <div className="schedule-paste-follow-up">
      <label>
        <input type="checkbox" checked={rescheduleSuccessors} aria-describedby="schedule-paste-follow-up-help"
          onChange={event => updateSuccessorReview(event.currentTarget.checked)} />
        후행 일정 함께 검토
      </label>
      <p id="schedule-paste-follow-up-help">{followUpDescription}</p>
      {rescheduleSuccessors && !blockerLinks && (
        <div className="schedule-paste-team-follow-up">
          <label>
            <input type="checkbox" checked={includeTeamBlockers} aria-describedby="schedule-paste-team-follow-up-help"
              onChange={event => {
                setIncludeTeamBlockers(event.currentTarget.checked);
                resetReview(true);
              }} />
            프로젝트 간 차단 포함
          </label>
          <p id="schedule-paste-team-follow-up-help">
            프로젝트 간 차단으로 이어진 후행 업무도 각 프로젝트의 근무일을 기준으로 검토합니다.
          </p>
        </div>
      )}
    </div>
  );
  const dateDraftFields = dateDraftRows.length > 0 && <GanttBulkLinkDateFields rows={dateDraftRows} excluded={excludedDateDrafts}
    onInclude={updateDateDraftInclusion} onChoose={chooseDateDraft}
    projectNames={projectNames ?? undefined} pasted={Boolean(clipboard)}
    description={clipboard ? '저장할 업무와 날짜를 확인하세요. 행에 작성 중인 날짜는 간트에서 계속 편집할 수 있습니다.' : bulkDates
      ? '포함한 초안은 해당 업무의 같은 날짜 항목에서 위 공통 변경보다 우선합니다. 제외한 초안은 간트에 남습니다.'
      : undefined} />;
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
                ? `${linkDescription} ${linkInstructions}`
                : clipboard ? '날짜를 붙여넣은 칸부터 간트에 표시된 순서대로 업무를 찾았습니다.' : bulkDates
                  ? '날짜별 공통 변경과 업무별 간트 초안을 함께 검토할 수 있습니다.'
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

        <form id={formId} className="schedule-paste-input" onSubmit={preview}>
          <fieldset disabled={editLocked}>
            {bulk && !clipboard && !(bulkLinks && chainMode) && (
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
            {Boolean(clipboard?.unavailableKeys.length) && <p className="schedule-paste-error" role="alert">
              {clipboard?.unavailableKeys.join(', ')} 업무가 이동되거나 삭제되었습니다. 현재 간트에서 날짜를 다시 붙여넣으세요.
            </p>}
            {blockerLinks ? (
              <GanttBlockerLinkPicker projectId={projectId} projects={blockerLinks.projects} projectFilterRef={blockerProjectFilter}
                issues={blockerIssuesById} dependencyFor={dependencyFor}
                selection={blockerSelection} refreshKey={blockerRefreshKey} onChange={updateBlockers} />
            ) : bulkLinks ? (
              <>
                <div className="schedule-bulk-date-fields">
                  <label className="schedule-bulk-link-mode schedule-bulk-date-field">연결 방식
                    <select ref={linkModeSelect} className="field" value={linkMode} onChange={event => {
                      const mode = event.currentTarget.value;
                      if (mode === 'anchor' || mode === 'chain') updateLinkMode(mode);
                    }}>
                      <option value="anchor" disabled={!anchors.length}>공통 기준 업무 연결</option>
                      <option value="chain">순서대로 연결</option>
                    </select>
                  </label>
                  <label className="schedule-bulk-link-mode schedule-bulk-date-field">연결 작업
                    <select className="field" value={linkOperation} onChange={event => {
                      const operation = event.currentTarget.value;
                      if (operation === 'add' || operation === 'update' || operation === 'remove') updateLinkOperation(operation);
                    }}>
                      <option value="add">새 연결 추가</option>
                      <option value="update">기존 연결 수정</option>
                      <option value="remove">기존 연결 해제</option>
                    </select>
                  </label>
                </div>
                {chainMode ? <GanttBulkChainFields issues={chainIssues} value={chainRule} onChange={updateChainRule} onMove={moveChainIssue}
                    operation={linkOperation} changes={linkRuleChanges} onChanges={updateLinkRuleChanges} />
                  : <GanttBulkLinkFields anchors={anchors} anchor={anchor} issueAliases={bulkLinks.issueAliases} searchRef={anchorSearch} query={anchorQuery}
                    value={link} onSearch={setAnchorQuery} onChange={updateLink}
                    operation={linkOperation} changes={linkRuleChanges} onChanges={updateLinkRuleChanges} />}
                {dateDraftFields}
                {followUpOption}
              </>
            ) : bulkDates ? (
              <>
                {!clipboard && <div className="schedule-bulk-date-fields">
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
                          {field !== 'dueDate' && <option value="workdays" disabled={durationEndpoint !== null && durationEndpoint !== field}>근무일로 계산</option>}
                        </select>
                        {entry.action === 'set' && (
                          <input type="date" className="field" aria-label={`${label} 값`}
                            max="9999-12-31" required value={entry.value}
                            onChange={event => updateDate(field, { ...entry, value: event.target.value })} />
                        )}
                        {entry.action === 'workdays' && <>
                          <label htmlFor={`schedule-bulk-${field}-duration`}>근무일 수</label>
                          <input id={`schedule-bulk-${field}-duration`} type="number" className="field" aria-label={`${label} 근무일 수`} inputMode="numeric"
                            min={1} max={MAX_WORKING_DURATION_DAYS} step={1} required value={workingDays} onChange={event => {
                              setWorkingDays(event.currentTarget.value);
                              resetReview(true);
                            }} />
                        </>}
                      </div>
                    );
                  })}
                </div>}
                {durationEndpoint && <p className="muted">각 업무의 {durationEndpoint === 'endDate' ? '시작일' : '종료일'}과 프로젝트 달력으로 계산합니다. 포함한 간트 초안의 날짜가 우선합니다.</p>}
                {dateDraftFields}
                {followUpOption}
              </>
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
                  업무 키와 선행 업무는 현재 키, Jira 원래 키 또는 이동 전 키로 입력하세요.
                  선행 업무가 여러 개면 후행 업무 키를 연결마다 한 행씩 적으세요.
                  내려받은 일정표는 <strong>내보낸 기준</strong> 열까지 함께 붙여넣으세요.
                  {isTeamPaste && ' 선후행 업무는 같은 프로젝트에 속해야 합니다.'}
                </p>
                {followUpOption}
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
                : pending === 'preview' && bulkLinks ? editsLinkDates ? '선택한 날짜와 선후행 연결을 검토하는 중입니다.'
                  : '선택한 업무의 선후행 연결을 검토하는 중입니다.'
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
              {directLinks && applied.updated.length > 0 && `날짜 ${applied.updated.length}건을 변경했습니다. `}
              {directLinks ? (applied.dependencyChanges || !applied.updated.length
                ? `${bulkLinkResultMessage(applied.dependencyChanges ?? 0, reviewedOperation)} ` : null)
                : bulkDates ? bulkDateResultMessage(applied.updated, team)
                  : `날짜 ${applied.updated.length}건과 업무 연결 ${applied.dependencyChanges ?? 0}건의 변경을 적용했습니다.`}
              {appliedFollowUpCount > 0 && ` 후행 일정 ${appliedFollowUpCount}건을 조정했습니다.`}
              적용 후 경고와 되돌리기는 간트에서 확인할 수 있습니다.
            </p>
          )}
          {sheetConflicts.length > 0 && !applied && (
            <section className="schedule-paste-sheet-conflicts" aria-label="일정표 값 비교">
              <h3>같은 칸에서 바뀐 일정 값 {sheetConflicts.length}개</h3>
              <p>칸마다 사용할 값을 고른 뒤 다시 미리보기를 만드세요.</p>
              <PagedList label="일정표 값 비교" items={sheetConflicts} render={conflict => (
                <li key={conflict.id}>
                  <label>
                    <strong>{conflict.line}행 · {conflict.key} · {conflict.label}</strong>
                    <span>내보낸 값 {conflict.original ?? '미정'} · 현재 {conflict.current ?? '미정'} · 입력 {conflict.input ?? '미정'}</span>
                    <select className="field" aria-label={`${conflict.line}행 ${conflict.key} ${conflict.label} 선택`}
                      value={sheetChoices[conflict.id] ?? ''} disabled={editLocked} onChange={event => updateSheetChoice(conflict.id, event.target.value)}>
                      <option value="">선택하세요</option>
                      <option value="current">현재 값 사용</option>
                      <option value="input">일정표 값 사용</option>
                    </select>
                  </label>
                </li>
              )} />
              <button className="btn" type="submit" form={formId} disabled={editLocked || !canPreview}>
                선택한 값으로 다시 미리보기
              </button>
            </section>
          )}
          {rejected && (inputErrors.length > 0 || rejectedMissingDependencies.length > 0) && (
            <section className="schedule-paste-rejected" aria-label={directLinks ? '선후행 연결 오류' : bulkDates ? '선택 업무 날짜 오류' : '일정 붙여넣기 오류'}>
              <h3>적용할 수 없는 입력 {inputErrors.length}건</h3>
              <p>
                오류를 수정하고 미리보기를 다시 만드세요. 이전 변경안이 있으면 아래에 참고용으로 남겨
                둡니다.
              </p>
              <PagedList
                label={directLinks ? '선후행 연결 오류' : bulkDates ? '업무 날짜 오류' : '붙여넣기 오류'}
                items={inputErrors}
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
              {rejectedMissingDependencies.length > 0 && <DependencyChangeTable changes={rejectedMissingDependencies} mode="missing" />}
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
                    {directLinks ? `${reviewedLinkDates ? `날짜 변경 ${result.changes.length}건 · 연결 ` : ''}${reviewedOperationLabel} ${dependencyChanges.length}건 · 유지 ${result.unchanged}건`
                      : bulkDates ? `변경 ${result.changes.length}개 · 유지 ${result.unchanged}개`
                        : `날짜 ${result.changes.length}건 · 업무 연결 ${dependencyChanges.length}건 · 유지 ${result.unchanged}행`}
                  </h3>
                  {missingDependencies.length > 0 && <p>연결 없음 {missingDependencies.length}건</p>}
                  {followUpIssues.size > 0 && <p>후행 일정 조정 {followUpIssues.size}건</p>}
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
                  {directLinks ? `${mixedLinkReview ? '변경할 날짜나 ' : ''}${reviewedOperationLabel}할 선후행 연결이 없습니다.`
                    : bulkDates ? '선택한 업무에서 바꿀 날짜가 없습니다.' : '변경할 날짜나 업무 연결이 없습니다.'}
                </p>
              )}
              {keyMappings.length > 0 && <ScheduleKeyMappings mappings={keyMappings}
                teamProjects={teamProjects} projectLabel={projectLabel} />}
              {result.warnings.length > 0 && (
                <WarningList warnings={result.warnings} label="일정 검토 경고" />
              )}
              {result.changes.length > 0 && (
                <ChangeTable changes={result.changes} bulk={Boolean(bulkDates || bulkLinks)} projects={review?.projects}
                  teamProjects={dateChangeProjects} followUpIssues={followUpIssues}
                  label={bulk && followUpIssues.size ? '선택 업무와 후행 업무 날짜 변경 목록' : undefined} />
              )}
              {dependencyChanges.length > 0 && (
                <DependencyChangeTable changes={dependencyChanges} mode={directLinks ? reviewedOperation : 'paste'} teamProjects={teamProjects} />
              )}
              {retainedDependencies.length > 0 && <DependencyChangeTable changes={retainedDependencies} mode="retained"
                teamProjects={teamProjects} showInputLine={!directLinks} />}
              {!rejected && missingDependencies.length > 0 && <DependencyChangeTable changes={missingDependencies} mode="missing" />}
            </section>
          )}
        </div>

        <footer>
          <span>
            {applied
              ? '적용 후 간트에서 되돌리기를 사용할 수 있습니다.'
              : retryApply
                ? '적용 여부가 확인되지 않았습니다. 같은 요청의 결과를 확인하세요.'
                : directLinks ? mixedLinkReview ? '검토한 날짜와 선후행 연결을 함께 적용합니다.'
                    : `검토한 선후행 연결을 한 번에 ${linkOperationLabel}합니다.`
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
              {directLinks ? mixedLinkReview ? '날짜와 선후행 연결 적용' : '검토한 연결 적용' : '검토한 일정 적용'}
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

function ScheduleKeyMappings({ mappings, teamProjects, projectLabel }: {
  mappings: NonNullable<SchedulePastePreview['keyMappings']>;
  teamProjects?: ProjectLabels;
  projectLabel?: string;
}) {
  const label = '이전 업무 키 확인';
  return <section className="schedule-paste-key-mappings" aria-label={label}>
    <h4>{label} {mappings.length}건</h4>
    {mappings.some(mapping => mapping.currentKeyConflict) && <p className="schedule-paste-key-guidance">
      입력한 키와 같은 이전 업무 키가 있습니다. 다른 업무가 대상이면 해당 업무의 현재 키로 바꾸거나 프로젝트 범위를 좁힌 뒤 미리보기를 다시 만드세요.
    </p>}
    <PagedList label={label} items={mappings} render={mapping => {
      const { inputKey, key, title, projectId, source, currentKeyConflict } = mapping;
      const inputLabel = source === 'current' ? `입력한 키 ${inputKey}` : issueSearchAliasLabel({ key: inputKey, source });
      const project = teamProjects?.get(projectId) ?? (projectLabel ? { id: projectId, name: projectLabel } : undefined);
      return <li key={inputKey}>
        <div className="schedule-paste-key-input">
          <span>{inputLabel}</span>
          {currentKeyConflict && <small className="schedule-paste-key-conflict">현재 키 우선</small>}
        </div>
        <div>
          <span aria-hidden="true">→ </span><span className="sr-only">현재 업무 </span><strong>{key}</strong> {title}
          <ScheduleProject project={project} />
        </div>
      </li>;
    }} />
  </section>;
}

function ChangeTable({ changes, bulk, projects, teamProjects, followUpIssues, label }: {
  changes: SchedulePastePreview['changes']; bulk: boolean; projects?: ProjectLabels; teamProjects?: ProjectLabels;
  followUpIssues: ReadonlySet<string>; label?: string;
}) {
  const [offset, setOffset] = useState(0);
  const start = Math.min(offset, Math.max(0, Math.floor((changes.length - 1) / PAGE_SIZE) * PAGE_SIZE));
  const showDueDate = !bulk && changes.some(hasDueDateChange);
  return (
    <div className={`schedule-paste-change-table${bulk ? ' schedule-bulk-date-table' : ''}`}>
      <div className="schedule-paste-table-scroll" tabIndex={!bulk ? 0 : undefined}
        role={!bulk ? 'region' : undefined} aria-label={!bulk ? '일정 변경 표 스크롤' : undefined}>
        <table aria-label={label ?? (bulk ? '선택 업무 날짜 변경 목록' : '붙여넣기 일정 변경 목록')}>
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
                  {followUpIssues.has(change.id) && <small className="schedule-paste-follow-up-label">후행 조정</small>}
                </th>
                {bulk ? (
                  <>
                    <DateChangeCell before={change.fromStart} after={change.toStart} />
                    <DateChangeCell before={change.fromEnd} after={change.toEnd} />
                    {hasDueDateChange(change)
                      ? <DateChangeCell before={change.fromDue ?? null} after={change.toDue ?? null} />
                      : <td>유지</td>}
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

const dependencyTableLabels = {
  paste: '붙여넣기 업무 연결 변경 목록',
  add: '새 선후행 연결 목록',
  update: '수정할 선후행 연결 목록',
  remove: '해제할 선후행 연결 목록',
  retained: '유지할 선후행 연결 목록',
  missing: '연결이 없는 업무 목록',
};

function DependencyChangeTable({ changes, mode, teamProjects, showInputLine = mode === 'paste' }: {
  changes: (SchedulePasteDependencyChange | SchedulePasteDependencyPair)[];
  mode: keyof typeof dependencyTableLabels;
  teamProjects?: ProjectLabels;
  showInputLine?: boolean;
}) {
  const [offset, setOffset] = useState(0);
  const start = Math.min(offset, Math.max(0, Math.floor((changes.length - 1) / PAGE_SIZE) * PAGE_SIZE));
  const label = dependencyTableLabels[mode];
  const showProposedRule = mode !== 'missing' && mode !== 'retained';
  const proposedRuleLabel = mode === 'add' ? '추가할 연결' : mode === 'remove' ? '해제 후' : '변경할 연결';
  return (
    <div className="schedule-paste-change-table schedule-paste-dependency-table">
      {mode !== 'paste' && <h4>{label}</h4>}
      <table aria-label={label}>
        <thead>
          <tr>
            <th scope="col">선행 → 후행 업무</th>
            {mode !== 'missing' && <th scope="col">{mode === 'retained' ? '유지할 연결' : '현재 연결'}</th>}
            {showProposedRule && <th scope="col">{proposedRuleLabel}</th>}
          </tr>
        </thead>
        <tbody>
          {changes.slice(start, start + PAGE_SIZE).map((change) => (
            <tr key={change.line}>
              <th scope="row">
                {showInputLine && <small>입력 {change.line}행</small>}
                {change.projectId && <ScheduleProject project={teamProjects?.get(change.projectId)} />}
                <small>{change.predecessorKey}</small>
                <strong>{change.predecessorTitle}</strong>
                <ArrowDown className="schedule-paste-dependency-arrow" aria-hidden="true" size={14} />
                <small>{change.successorKey}</small>
                <strong>{change.successorTitle}</strong>
              </th>
              {'before' in change && <>
                <td><DependencyRule rule={change.before} action={mode === 'retained' ? '유지' : undefined} /></td>
                {showProposedRule && <td>
                  <DependencyRule rule={change.after}
                    action={!change.after ? mode === 'remove' ? '해제' : '삭제' : !change.before ? '추가' : '변경'} />
                </td>}
              </>}
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
  action?: '추가' | '변경' | '삭제' | '해제' | '유지';
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
