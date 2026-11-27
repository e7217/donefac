'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { PRIORITY, type CustomFieldValue, type CycleBoardCreateInput, type DependencyType, type DocPage, type DocumentDecisionSource, type DocumentFollowUpCommentSource, type DocumentFollowUpResult, type DocumentSourceSelection, type FeatureProps, type Issue, type IssueBlockedCreationResult, type IssueChildCreationResult, type IssueCloneResult, type IssueDescriptionFormat, type IssueStatus, type IssueTemplate, type PlanningItem, type Priority, type WorkCalendar, type WorkspaceSnapshot } from '../../shared/types';
import { projectStatuses, projectWorkflow, requiredFieldsFor, REQUIRED_FIELD_LABELS } from '../../shared/workflow-helpers';
import { fieldApplies, hasCustomValue, projectIssueSchema, projectIssueTypes, requiredFieldLabels, visibleIssueFieldIds } from '../../shared/issue-schema';
import { MAX_PLANNED_EFFORT_MINUTES } from '../../shared/project-workload';
import { CalendarError, createCalendarMath, defaultWorkCalendar } from '../../shared/calendar';
import { gitlabFollowUpPath, type GitlabFollowUpPreview } from '../../shared/gitlab-follow-up';
import { DEPENDENCY_ENDPOINTS, DEPENDENCY_LABELS, DEPENDENCY_TYPES, MAX_DEPENDENCY_LAG_DAYS, SCHEDULE_DATE_LABELS, dependencyBound, dependencyPredecessorBound, dependencyScheduleWarning, isDependencyLag, isDependencyType, type ScheduleDependencyEndpoint } from '../../shared/schedule-dependencies';
import { api, ApiError } from '../lib/api';
import { createIssueAttempt, isDefiniteIssueCreationFailure, requestIssueCreation, type IssueCreationAttempt } from '../lib/issue-creation';
import { afterAcceptedNavigation } from '../lib/navigation';
import { newRequestId } from '../lib/request-id';
import { CustomFields, initialIssueType, IssueTypeSelect } from './CustomFields';
import { PlanningSelect } from './PlanningSelectors';
import { IssueDescriptionEditor } from './IssueDescriptionEditor';
import { IssueReporterSelect } from './IssueReporterSelect';
import { IssueTemplatePicker } from './IssueTemplatePicker';
import { isAvailableTemplateFieldValue } from './issue-template-fields';
import { WorkingDayRangePicker } from './WorkingDayRangePicker';
import { errorMessage } from './schedule-utils';
import './issues.css';
import './issue-schedule-successor.css';

export type FollowUpSource = Pick<DocPage, 'id' | 'title' | 'version' | 'projectId'> & (
  { sourceSelection?: DocumentSourceSelection; checklistTitle?: never; comment?: never } |
  { sourceSelection: DocumentSourceSelection; checklistTitle: string; comment?: never } |
  { sourceSelection?: never; checklistTitle?: never; comment: { id: string; body: string; source: DocumentDecisionSource } }
);
type ParentIssue = Pick<Issue, 'id' | 'key' | 'title' | 'projectId' | 'version'>;
type ScheduledIssue = ParentIssue & Pick<Issue, 'startDate' | 'endDate'>;
export type ScheduleIssueLink = {
  direction: 'predecessor' | 'successor';
  issue: ScheduledIssue;
};
type CycleBoardCycle = Pick<PlanningItem, 'id' | 'name' | 'status' | 'version'>;
type CycleBoardCreation = { cycle: CycleBoardCycle | null; onCreated: (issue: Issue) => void };
type Props = Pick<FeatureProps, 'data' | 'projectId' | 'actorId' | 'refresh' | 'notify' | 'openIssue'> & {
  initialStatus?: IssueStatus;
  initialBoardAssigneeId?: string | null;
  selectingChecklist?: boolean;
  onReselectChecklist?: () => void;
  gitlabFollowUp?: GitlabFollowUpPreview;
  onGitlabFollowUpCreated?: (issue: Issue) => void;
  onClose: () => void;
} & (
  (({ sourceDocument?: FollowUpSource; cycleBoardCreation?: never } | { sourceDocument?: never; cycleBoardCreation: CycleBoardCreation }) &
    { parentIssue?: never; scheduleLink?: never; onScheduleIssueCreated?: never; cloneIssue?: never; onCloneCreated?: never; blockedByIssue?: never; onBlockedIssueCreated?: never }) |
  { cycleBoardCreation?: never; sourceDocument?: never; parentIssue: ParentIssue; scheduleLink?: never; onScheduleIssueCreated?: never; cloneIssue?: never; onCloneCreated?: never; blockedByIssue?: never; onBlockedIssueCreated?: never } |
  { cycleBoardCreation?: never; sourceDocument?: never; parentIssue?: never; scheduleLink: ScheduleIssueLink; onScheduleIssueCreated?: (issue: Issue) => void; cloneIssue?: never; onCloneCreated?: never; blockedByIssue?: never; onBlockedIssueCreated?: never } |
  { cycleBoardCreation?: never; sourceDocument?: never; parentIssue?: never; scheduleLink?: never; onScheduleIssueCreated?: never; cloneIssue: Issue; onCloneCreated?: (issue: Issue) => void; blockedByIssue?: never; onBlockedIssueCreated?: never } |
  { cycleBoardCreation?: never; sourceDocument?: never; parentIssue?: never; scheduleLink?: never; onScheduleIssueCreated?: never; cloneIssue?: never; onCloneCreated?: never; blockedByIssue: ScheduledIssue; onBlockedIssueCreated?: (issue: Issue) => void }
);
type ParentReview = { state: 'available'; issue: ParentIssue } | { state: 'missing' | 'moved' | 'failed' };
type CloneReview = { state: 'available'; issue: Issue } | { state: 'missing' | 'moved' | 'failed' };
type ReviewedSchedule = ScheduleIssueLink & { calendar: WorkCalendar };
type ScheduleReview = { state: 'available'; schedule: ReviewedSchedule } | { state: 'missing' | 'moved' | 'failed' };
type BlockedReview = { state: 'available'; issue: ScheduledIssue; calendar: WorkCalendar | null } |
  { state: 'missing' | 'moved' | 'project_missing' | 'failed' };
type CycleReview = { state: 'available'; cycle: CycleBoardCycle } | { state: 'missing' | 'closed' | 'failed' };
type ScheduleDates = Record<ScheduleDependencyEndpoint, string>;
type CloneDates = ScheduleDates & { dueDate: string };

const scheduleCreation = {
  predecessor: {
    role: '선행', anchorRole: '후행', path: 'schedule-predecessors', versionField: 'expectedSuccessorVersion',
    changed: 'successor_changed', missing: 'successor_missing',
  },
  successor: {
    role: '후행', anchorRole: '선행', path: 'schedule-successors', versionField: 'expectedPredecessorVersion',
    changed: 'predecessor_changed', missing: 'predecessor_missing',
  },
} as const;

function cloneReviewFrom(data: WorkspaceSnapshot, previous: Issue): CloneReview | null {
  const issue = data.issues.find(candidate => candidate.id === previous.id);
  if (!issue) return { state: 'missing' };
  if (issue.projectId !== previous.projectId) return { state: 'moved' };
  return issue.version > previous.version ? { state: 'available', issue } : null;
}

function cloneCustomFields(data: WorkspaceSnapshot, source: Issue, type: string, status: IssueStatus) {
  const schema = projectIssueSchema(data, source.projectId);
  const sourceVisible = visibleIssueFieldIds(schema, source);
  const copied: Array<[string, CustomFieldValue]> = [];
  for (const field of schema.fields) {
    const value = source.customFields?.[field.id];
    if (!sourceVisible.has(field.id) || value === undefined || !hasCustomValue(value)) continue;
    const activeOption = (id: CustomFieldValue) => field.options.some(option => option.id === id && !option.archived);
    if (field.kind === 'select' && !activeOption(value)) continue;
    if (field.kind === 'user' && !data.users.some(user => user.id === value)) continue;
    if (field.kind === 'multi_select') {
      const options = Array.isArray(value) ? value.filter(activeOption) : [];
      if (options.length) copied.push([field.id, options]);
    } else {
      copied.push([field.id, value]);
    }
  }
  const targetVisible = visibleIssueFieldIds(schema, { type, status, customFields: Object.fromEntries(copied) });
  return Object.fromEntries(copied.filter(([id]) => targetVisible.has(id)));
}

function templateDraftFields(data: WorkspaceSnapshot, projectId: string, type: string, status: IssueStatus,
  values: Record<string, CustomFieldValue>, copiedIds: string[]) {
  const schema = projectIssueSchema(data, projectId);
  const copied = new Set(copiedIds);
  const available = Object.entries(values).filter(([id, value]) => {
    const field = schema.fields.find(candidate => candidate.id === id);
    return field && !field.archived && fieldApplies(field, type)
      && (!copied.has(id) || isAvailableTemplateFieldValue(field, value, data.users));
  });
  const visible = visibleIssueFieldIds(schema, { type, status, customFields: Object.fromEntries(available) });
  return Object.fromEntries(available.filter(([id]) => !copied.has(id) || visible.has(id)));
}

function calendarFor(data: WorkspaceSnapshot, projectId: string) {
  return data.calendars?.find(calendar => calendar.projectId === projectId) ?? defaultWorkCalendar(projectId);
}

function scheduleReviewFrom(data: WorkspaceSnapshot, previous: ReviewedSchedule, authoritative = false): ScheduleReview | null {
  const issue = data.issues.find(candidate => candidate.id === previous.issue.id);
  if (!issue) return { state: 'missing' };
  if (issue.projectId !== previous.issue.projectId) return { state: 'moved' };
  const calendar = calendarFor(data, issue.projectId);
  if (authoritative) return { state: 'available', schedule: { direction: previous.direction, issue, calendar } };
  if (issue.version <= previous.issue.version && calendar.version <= previous.calendar.version) return null;
  return { state: 'available', schedule: {
    direction: previous.direction,
    issue: issue.version >= previous.issue.version ? issue : previous.issue,
    calendar: calendar.version >= previous.calendar.version ? calendar : previous.calendar,
  } };
}

function blockedReviewFrom(data: WorkspaceSnapshot, previous: ScheduledIssue, calendar: WorkCalendar | null,
  authoritative = false): BlockedReview | null {
  const issue = data.issues.find(candidate => candidate.id === previous.id);
  if (!issue) return { state: 'missing' };
  if (issue.projectId !== previous.projectId) return { state: 'moved' };
  if (calendar && !data.projects.some(project => project.id === calendar.projectId)) return { state: 'project_missing' };
  const latestCalendar = calendar && calendarFor(data, calendar.projectId);
  if (authoritative) return { state: 'available', issue, calendar: latestCalendar };
  if (issue.version <= previous.version && (!calendar || !latestCalendar || latestCalendar.version <= calendar.version)) return null;
  return { state: 'available', issue: issue.version >= previous.version ? issue : previous,
    calendar: calendar && latestCalendar && calendar.version >= latestCalendar.version ? calendar : latestCalendar };
}

function cycleReviewFrom(data: WorkspaceSnapshot, projectId: string, previous: CycleBoardCycle, authoritative = false): CycleReview | null {
  if (!data.planningItems) return authoritative ? { state: 'failed' } : null;
  const cycle = data.planningItems.find(item => item.id === previous.id && item.kind === 'cycle' && item.projectId === projectId);
  if (!cycle) return { state: 'missing' };
  if (cycle.status !== 'planned' && cycle.status !== 'active') return { state: 'closed' };
  return authoritative || cycle.version > previous.version ? { state: 'available', cycle } : null;
}

function scheduleProposal(schedule: ReviewedSchedule, type: DependencyType, lagDays: number | null, dates?: ScheduleDates) {
  if (lagDays === null) return {};
  const relation = { type, lagDays };
  const direction = schedule.direction;
  const { role, anchorRole } = scheduleCreation[direction];
  const endpoint = DEPENDENCY_ENDPOINTS[type][direction === 'predecessor' ? 'successor' : 'predecessor'];
  if (!schedule.issue[endpoint]) return { message: `${anchorRole} 업무의 ${SCHEDULE_DATE_LABELS[endpoint]}이 비어 있어 날짜를 제안할 수 없습니다.` };
  try {
    const math = createCalendarMath(schedule.calendar);
    const suggestion = direction === 'predecessor'
      ? dependencyPredecessorBound(relation, schedule.issue, math)
      : dependencyBound(relation, schedule.issue, math);
    const draft = dates && { key: `${role} 업무`, startDate: dates.startDate || null, endDate: dates.endDate || null };
    const warning = draft && (direction === 'predecessor'
      ? dependencyScheduleWarning(relation, draft, schedule.issue, math)
      : dependencyScheduleWarning(relation, schedule.issue, draft, math));
    return { suggestion, warning };
  } catch (cause) {
    if (!(cause instanceof CalendarError)) throw cause;
    return { message: cause.message };
  }
}

function titleFromChecklist(text: string): string {
  // Match the issue title's UTF-16 limit without leaving a split surrogate at the end.
  return text.replace(/\s+/gu, ' ').trim().slice(0, 300).replace(/[\uD800-\uDBFF]$/u, '').trimEnd();
}

export function NewIssueModal({ data, projectId, actorId, initialStatus, initialBoardAssigneeId, sourceDocument, selectingChecklist = false,
  onReselectChecklist, parentIssue, scheduleLink, onScheduleIssueCreated, cloneIssue, onCloneCreated, blockedByIssue, cycleBoardCreation,
  onBlockedIssueCreated, gitlabFollowUp, onGitlabFollowUpCreated, onClose, refresh, notify, openIssue }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sourceComment = sourceDocument?.comment;
  const checklistMode = sourceDocument?.checklistTitle !== undefined;
  const checklistPicking = checklistMode && selectingChecklist;
  const [initialTitle] = useState(() => cloneIssue?.title ?? (gitlabFollowUp
    ? `${gitlabFollowUp.source.key} · ${gitlabFollowUp.evidence.label} ${gitlabFollowUp.evidence.state} 후속 작업`
    : checklistMode ? titleFromChecklist(sourceDocument.checklistTitle) : undefined));
  const [previousChecklistSource, setPreviousChecklistSource] = useState(checklistMode ? sourceDocument : undefined);
  const [description, setDescription] = useState(cloneIssue?.description ?? sourceComment?.body ?? '');
  const [priority, setPriority] = useState<Priority>(cloneIssue?.priority ?? 'medium');
  const [appliedTemplate, setAppliedTemplate] = useState<IssueTemplate | null>(null);
  const [templateError, setTemplateError] = useState('');
  const [templateNotice, setTemplateNotice] = useState('');
  const [templateLabels, setTemplateLabels] = useState<{ text: string; labels: string[] }>();
  const [templateFieldIdsByProject, setTemplateFieldIdsByProject] = useState<Record<string, string[]>>({});
  const [reporterId, setReporterId] = useState<Issue['reporterId']>();
  const [descriptionFormat, setDescriptionFormat] = useState<IssueDescriptionFormat>(cloneIssue?.descriptionFormat ?? 'plain');
  const [selectedProject, setSelectedProject] = useState(() => {
    if (gitlabFollowUp) return gitlabFollowUp.source.projectId;
    if (cycleBoardCreation) return projectId;
    if (parentIssue) return parentIssue.projectId;
    if (scheduleLink) return scheduleLink.issue.projectId;
    if (cloneIssue) return cloneIssue.projectId;
    if (blockedByIssue) return '';
    if (sourceDocument) return sourceDocument.projectId ?? '';
    return !projectId || projectId === 'all' ? data.projects[0]?.id || '' : projectId;
  });
  const [selectedType, setSelectedType] = useState(() => cloneIssue && projectIssueTypes(data, selectedProject).some(type => type.id === cloneIssue.type)
    ? cloneIssue.type : initialIssueType(data, selectedProject));
  const [selectedStatus, setSelectedStatus] = useState(() => !cloneIssue && initialStatus && projectStatuses(data, selectedProject).some(status => status.id === initialStatus)
    ? initialStatus : projectWorkflow(data, selectedProject).initialStatusId);
  const [valuesByProject, setValuesByProject] = useState<Record<string, Record<string, CustomFieldValue>>>(() => cloneIssue
    ? { [selectedProject]: cloneCustomFields(data, cloneIssue, selectedType, selectedStatus) } : {});
  const [sourceVersion, setSourceVersion] = useState(sourceDocument?.version);
  const [sourceSelection, setSourceSelection] = useState(sourceDocument?.sourceSelection);
  const [reviewedParent, setReviewedParent] = useState(parentIssue);
  const [reviewedGitlab, setReviewedGitlab] = useState(gitlabFollowUp);
  const [needsGitlabReview, setNeedsGitlabReview] = useState(false);
  const [parentReview, setParentReview] = useState<ParentReview | null>(null);
  const [reviewedClone, setReviewedClone] = useState(cloneIssue);
  const [cloneReview, setCloneReview] = useState<CloneReview | null>(null);
  const [cloneDates, setCloneDates] = useState<CloneDates>({ startDate: '', endDate: '', dueDate: '' });
  const [reviewedSchedule, setReviewedSchedule] = useState<ReviewedSchedule | null>(() => scheduleLink
    ? { ...scheduleLink, calendar: calendarFor(data, scheduleLink.issue.projectId) } : null);
  const [scheduleReview, setScheduleReview] = useState<ScheduleReview | null>(null);
  const [reviewedBlocked, setReviewedBlocked] = useState(blockedByIssue);
  const [blockedCalendar, setBlockedCalendar] = useState<WorkCalendar | null>(null);
  const [blockedReview, setBlockedReview] = useState<BlockedReview | null>(null);
  const [reviewedCycle, setReviewedCycle] = useState(cycleBoardCreation?.cycle);
  const [cycleReview, setCycleReview] = useState<CycleReview | null>(null);
  const [dependencyType, setDependencyType] = useState<DependencyType>('FS');
  const [lag, setLag] = useState('0');
  const [scheduleDates, setScheduleDates] = useState<ScheduleDates>(() => {
    const date = reviewedSchedule ? scheduleProposal(reviewedSchedule, 'FS', 0).suggestion?.date ?? '' : '';
    return { startDate: date, endDate: date };
  });
  const [scheduleDatesCustomized, setScheduleDatesCustomized] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [replayRejected, setReplayRejected] = useState(false);
  const [versionConflict, setVersionConflict] = useState(false);
  if (checklistMode && sourceDocument !== previousChecklistSource) {
    setPreviousChecklistSource(sourceDocument);
    setSourceVersion(sourceDocument.version);
    setSourceSelection(sourceDocument.sourceSelection);
    if (sourceDocument.projectId && sourceDocument.projectId !== selectedProject) {
      setSelectedProject(sourceDocument.projectId);
      setSelectedType(initialIssueType(data, sourceDocument.projectId));
      setSelectedStatus(projectWorkflow(data, sourceDocument.projectId).initialStatusId);
    }
    setVersionConflict(false);
    setError('');
  }
  const attempt = useRef<IssueCreationAttempt | null>(null);
  const dirtyRef = useRef(false);
  const pendingRef = useRef(false);
  const dialog = useRef<HTMLElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const labelInput = useRef<HTMLInputElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  const values = valuesByProject[selectedProject] || {};
  const templateFieldIds = templateFieldIdsByProject[selectedProject];
  const formValues = templateFieldIds ? templateDraftFields(data, selectedProject, selectedType, selectedStatus, values, templateFieldIds) : values;
  const states = projectStatuses(data, selectedProject);
  const required = requiredFieldsFor(data, selectedProject, selectedType, selectedStatus);
  const currentDocument = sourceDocument && data.documents.find(page => page.id === sourceDocument.id);
  const canReviewVersion = versionConflict && currentDocument && (Boolean(sourceSelection) || currentDocument.version !== sourceVersion);
  const needsSourceReview = Boolean(canReviewVersion || (versionConflict && sourceSelection));
  const childMode = Boolean(parentIssue);
  const scheduleMode = Boolean(reviewedSchedule);
  const scheduleDirection = reviewedSchedule?.direction ?? 'successor';
  const scheduleCopy = scheduleCreation[scheduleDirection];
  const scheduleRole = scheduleCopy.role;
  const scheduleAnchorRole = scheduleCopy.anchorRole;
  const cloneMode = Boolean(reviewedClone);
  const gitlabFollowUpMode = Boolean(reviewedGitlab);
  const blockedMode = Boolean(reviewedBlocked);
  const rangeDates = cloneMode ? cloneDates : scheduleDates;
  const rangeCalendar = reviewedSchedule?.calendar ?? blockedCalendar ?? data.calendars?.find(calendar => calendar.projectId === selectedProject);
  const rangeMath = useMemo(() => selectedProject ? createCalendarMath(rangeCalendar ?? defaultWorkCalendar(selectedProject)) : null,
    [rangeCalendar, selectedProject]);
  const pendingCloneReview = cloneReview ?? (reviewedClone && cloneReviewFrom(data, reviewedClone));
  const needsCloneReview = Boolean(pendingCloneReview && !recovering && !replayRejected && !busy);
  const cloneLabels = cloneIssue?.labels.join('\n').replace(/\r\n?/g, '\n');
  const dynamicScheduleReview = reviewedSchedule && scheduleReviewFrom(data, reviewedSchedule);
  const pendingScheduleReview = scheduleReview ?? dynamicScheduleReview;
  const needsScheduleReview = Boolean(pendingScheduleReview && !recovering && !busy);
  const pendingBlockedReview = blockedReview ?? (reviewedBlocked && blockedReviewFrom(data, reviewedBlocked, blockedCalendar));
  const needsBlockedReview = Boolean(pendingBlockedReview && !recovering && !replayRejected && !busy);
  const pendingCycleReview = reviewedCycle && (cycleReview ?? cycleReviewFrom(data, projectId, reviewedCycle));
  const needsCycleReview = Boolean(pendingCycleReview && !recovering && !replayRejected && !busy);
  const cycleReviewMessage = pendingCycleReview?.state === 'missing' ? '등록할 사이클을 찾을 수 없습니다.'
    : pendingCycleReview?.state === 'closed' ? '선택한 사이클이 종료되어 업무를 등록할 수 없습니다.'
    : pendingCycleReview?.state === 'failed' ? '최신 사이클을 불러오지 못했습니다.'
    : '등록할 사이클이 변경되었습니다. 최신 사이클을 확인해 주세요.';
  const blockedReviewMessage = pendingBlockedReview?.state === 'missing' ? '차단하는 업무를 찾을 수 없습니다.'
    : pendingBlockedReview?.state === 'moved' ? '차단하는 업무가 다른 프로젝트로 이동했습니다.'
    : pendingBlockedReview?.state === 'project_missing' ? '대상 프로젝트를 찾을 수 없습니다. 다른 프로젝트를 선택해 주세요.'
    : pendingBlockedReview?.state === 'failed' ? '최신 차단 기준을 불러오지 못했습니다.'
    : '차단하는 업무 또는 대상 프로젝트 작업 달력이 변경됐습니다. 최신 차단 기준을 확인해 주세요.';
  const lagDays = lag.trim() && isDependencyLag(Number(lag)) ? Number(lag) : null;
  const proposal = reviewedSchedule ? scheduleProposal(reviewedSchedule, dependencyType, lagDays, scheduleDates) : {};
  const blockedProposal = reviewedBlocked && blockedCalendar
    ? scheduleProposal({ direction: 'successor', issue: reviewedBlocked, calendar: blockedCalendar }, 'FS', 0, scheduleDates) : {};
  const linkedPath = reviewedParent ? `/issues/${encodeURIComponent(reviewedParent.id)}/children`
    : reviewedSchedule ? `/issues/${encodeURIComponent(reviewedSchedule.issue.id)}/${scheduleCopy.path}`
    : reviewedClone ? `/issues/${encodeURIComponent(reviewedClone.id)}/clone`
    : reviewedBlocked ? `/issues/${encodeURIComponent(reviewedBlocked.id)}/blocked-issues`
    : reviewedGitlab ? gitlabFollowUpPath(reviewedGitlab.source.id, reviewedGitlab.evidence.linkId)
    : sourceDocument ? `/documents/${encodeURIComponent(sourceDocument.id)}/follow-up-issues` : undefined;
  const linkedCreation = Boolean(linkedPath);
  const usesIssueReceipt = !linkedCreation || scheduleMode || cloneMode || blockedMode || checklistMode || gitlabFollowUpMode;
  const currentParent = reviewedParent && data.issues.find(issue => issue.id === reviewedParent.id);
  const parentUnavailable = reviewedParent && (!currentParent || currentParent.projectId !== reviewedParent.projectId);
  const needsParentReview = Boolean(parentReview || parentUnavailable);
  const linkedError = error || (parentUnavailable ? '현재 프로젝트에서 상위 업무를 찾을 수 없습니다.' : '') ||
    (needsScheduleReview ? (pendingScheduleReview?.state === 'missing' ? `${scheduleAnchorRole} 업무를 찾을 수 없습니다.` :
      pendingScheduleReview?.state === 'moved' ? `${scheduleAnchorRole} 업무가 다른 프로젝트로 이동했습니다.` :
        `${scheduleAnchorRole} 업무 또는 프로젝트 작업 달력이 변경됐습니다. 최신 ${scheduleAnchorRole} 일정을 확인해 주세요.`) : '') ||
    (needsCloneReview ? (pendingCloneReview?.state === 'missing' ? '원본 업무를 찾을 수 없습니다.' :
      pendingCloneReview?.state === 'moved' ? '원본 업무가 다른 프로젝트로 이동했습니다.' :
      pendingCloneReview?.state === 'failed' ? '최신 원본 업무를 불러오지 못했습니다.' :
        '원본 업무가 변경됐습니다. 최신 원본 버전을 확인해 주세요.') : '') ||
    (needsBlockedReview ? blockedReviewMessage : '');
  const confirmationLocation = childMode ? '상위 업무의 하위 목록' : scheduleMode ? `${scheduleAnchorRole} 업무의 일정 연결 목록`
    : cloneMode || gitlabFollowUpMode ? '원본 업무의 관련 업무 목록' : blockedMode ? '차단하는 업무의 관계 목록' : sourceDocument ? '문서의 연결 목록'
    : cycleBoardCreation ? '백로그와 사이클 목록' : '업무 목록';
  const fieldsLocked = busy || recovering || (usesIssueReceipt && replayRejected);
  const refreshAfterClose = useCallback(() => {
    void refresh().catch(() => notify(childMode
      ? '하위 업무 목록을 불러오지 못했습니다. 상위 업무를 다시 열어 확인해 주세요.'
      : scheduleMode ? `일정 연결을 불러오지 못했습니다. ${scheduleAnchorRole} 업무를 다시 열어 확인해 주세요.`
      : cloneMode || gitlabFollowUpMode ? '관련 업무를 불러오지 못했습니다. 원본 업무를 다시 열어 확인해 주세요.'
      : blockedMode ? '차단 관계를 불러오지 못했습니다. 차단하는 업무를 다시 열어 확인해 주세요.'
      : sourceDocument ? '연결 목록을 불러오지 못했습니다. 문서를 다시 열어 확인해 주세요.'
      : '업무 목록을 불러오지 못했습니다. 목록을 다시 열어 확인해 주세요.', 'error'));
  }, [childMode, scheduleMode, scheduleAnchorRole, cloneMode, blockedMode, gitlabFollowUpMode, sourceDocument, refresh, notify]);
  const fromBoard = initialBoardAssigneeId !== undefined;
  const handlesNestedNavigation = childMode || scheduleMode || cloneMode || blockedMode || checklistMode || gitlabFollowUpMode || Boolean(cycleBoardCreation) || fromBoard;

  function close() {
    if (pendingRef.current) return;
    const uncertain = Boolean(attempt.current);
    if (uncertain) {
      if (!window.confirm(`업무가 이미 생성됐을 수 있습니다. ${confirmationLocation}에서 결과를 확인할 수 있습니다. 창을 닫을까요?`)) return;
    } else if (dirtyRef.current && !window.confirm('작성 중인 새 업무를 버리고 닫을까요?')) return;
    attempt.current = null;
    dirtyRef.current = false;
    onClose();
    if (uncertain) refreshAfterClose();
  }

  useEffect(() => {
    const guard = (event: Event) => {
      if (event.defaultPrevented) return;
      if (pendingRef.current) {
        event.preventDefault();
        notify('업무 생성이 끝난 뒤 이동해 주세요.', 'error');
        return;
      }
      const uncertain = Boolean(attempt.current);
      const confirmation = uncertain
        ? `업무가 이미 생성됐을 수 있습니다. 돌아와서 ${confirmationLocation}을 확인할 수 있습니다. 이동할까요?`
        : dirtyRef.current ? '작성 중인 새 업무를 버리고 이동할까요?' : '';
      if (confirmation && !window.confirm(confirmation)) event.preventDefault();
      else afterAcceptedNavigation(event, () => {
        attempt.current = null;
        dirtyRef.current = false;
        onClose();
        if (uncertain && usesIssueReceipt) refreshAfterClose();
      });
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current || pendingRef.current || attempt.current) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('donefac:navigate', guard, handlesNestedNavigation);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('donefac:navigate', guard, handlesNestedNavigation);
      window.removeEventListener('beforeunload', unload);
    };
  }, [handlesNestedNavigation, confirmationLocation, usesIssueReceipt, notify, onClose, refreshAfterClose]);

  useEffect(() => {
    if (handlesNestedNavigation && busy && !checklistPicking) dialog.current?.focus({ preventScroll: true });
  }, [busy, checklistPicking, handlesNestedNavigation]);

  useEffect(() => {
    const retry = submitButton.current;
    if (recovering && !busy && retry && !retry.disabled) retry.focus();
  }, [recovering, busy]);

  useEffect(() => {
    if (checklistMode && !checklistPicking) titleInput.current?.focus({ preventScroll: true });
  }, [checklistMode, checklistPicking]);

  function applyTemplate(template: IssueTemplate) {
    const defaults = template.defaults;
    const title = titleInput.current;
    const labels = labelInput.current;
    if (template.projectId !== selectedProject || !title || !labels) return;
    if (!projectIssueTypes(data, selectedProject).some(type => type.id === defaults.type)) {
      setTemplateError('이 템플릿의 업무 유형을 사용할 수 없습니다. 설정에서 템플릿을 수정해 주세요.');
      return;
    }
    const schema = projectIssueSchema(data, selectedProject);
    const customEntries = Object.entries(defaults.customFields).filter(([, value]) => hasCustomValue(value));
    const availableEntries = customEntries.filter(([id, value]) => {
      const field = schema.fields.find(candidate => candidate.id === id && !candidate.archived);
      return field && isAvailableTemplateFieldValue(field, value, data.users);
    });
    const draftValues = { ...values, ...Object.fromEntries(availableEntries) };
    const visible = visibleIssueFieldIds(schema, { type: defaults.type, status: selectedStatus, customFields: draftValues });
    const customDefaults = availableEntries.filter(([id]) => visible.has(id));
    const labelText = defaults.labels.join(', ');
    const replacesInput = (defaults.title && title.value.trim() && title.value !== defaults.title)
      || (description.trim() && (description !== defaults.description || descriptionFormat !== defaults.descriptionFormat))
      || (labels.value.trim() && labels.value !== labelText)
      || (selectedType !== initialIssueType(data, selectedProject) && selectedType !== defaults.type)
      || (priority !== 'medium' && priority !== defaults.priority)
      || customDefaults.some(([id, value]) => Object.hasOwn(values, id) && JSON.stringify(values[id]) !== JSON.stringify(value));
    if (replacesInput && !window.confirm('템플릿의 기본값으로 일부 입력을 바꿀까요?')) return;
    if (defaults.title) title.value = defaults.title;
    labels.value = labelText;
    setDescription(defaults.description);
    setDescriptionFormat(defaults.descriptionFormat);
    setSelectedType(defaults.type);
    setPriority(defaults.priority);
    setValuesByProject(previous => ({ ...previous, [selectedProject]: { ...values, ...Object.fromEntries(customDefaults) } }));
    setTemplateFieldIdsByProject(previous => ({ ...previous, [selectedProject]: [
      ...new Set([...(previous[selectedProject] ?? []), ...customDefaults.map(([id]) => id)]),
    ] }));
    setTemplateLabels({ text: labels.value, labels: defaults.labels });
    setAppliedTemplate(template);
    setTemplateError('');
    const skipped = customEntries.length - customDefaults.length;
    setTemplateNotice(skipped
      ? `현재 업무 양식에서 사용할 수 없는 사용자 정의 기본값 ${skipped}개를 제외했습니다. 유형·상태와 선택 항목을 확인해 주세요.` : '');
    dirtyRef.current = true;
  }

  function issuePayload(form: FormData) {
    const labelText = String(form.get('labels') || '');
    const labels = cloneIssue && labelText.replace(/\r\n?/g, '\n') === cloneLabels ? cloneIssue.labels
      : templateLabels && labelText === templateLabels.text ? templateLabels.labels
      : labelText.split(cloneMode ? /\r?\n/ : ',').map(value => value.trim()).filter(Boolean);
    return {
      projectId: selectedProject, title: String(form.get('title') || '').trim(), description,
      ...(appliedTemplate || descriptionFormat === 'markdown' || cloneIssue?.descriptionFormat === 'markdown' ? { descriptionFormat } : {}),
      ...(appliedTemplate ? { templateId: appliedTemplate.id, expectedTemplateVersion: appliedTemplate.version } : {}),
      type: selectedType, status: selectedStatus, priority: form.get('priority'), assigneeId: form.get('assigneeId') || null,
      ...(reporterId !== undefined ? { reporterId } : {}),
      startDate: form.get('startDate') || null, endDate: form.get('endDate') || null, dueDate: form.get('dueDate') || null,
      estimate: form.get('estimate') ? Number(form.get('estimate')) : null,
      plannedEffortMinutes: form.get('plannedEffortMinutes') ? Number(form.get('plannedEffortMinutes')) : null,
      labels,
      parentId: reviewedParent?.id ?? (form.get('parentId') || null), collaboratorIds: form.getAll('collaboratorIds'),
      ...(cycleBoardCreation ? {} : { cycleId: form.get('cycleId') || null }),
      moduleId: form.get('moduleId') || null, releaseId: form.get('releaseId') || null,
      customFields: formValues,
    };
  }

  async function readParentReview(parent: ParentIssue) {
    try {
      const snapshot = await api<WorkspaceSnapshot>('/workspace', { cache: 'no-store' });
      const latest = snapshot.issues.find(issue => issue.id === parent.id);
      if (!latest) {
        setParentReview({ state: 'missing' });
        setError('상위 업무를 찾을 수 없습니다.');
      } else if (latest.projectId !== parent.projectId) {
        setParentReview({ state: 'moved' });
        setError('상위 업무가 다른 프로젝트로 이동했습니다.');
      } else if (latest.version !== parent.version) {
        setParentReview({ state: 'available', issue: latest });
        setError('상위 업무가 변경됐습니다. 최신 상위 업무를 확인해 주세요.');
      } else {
        throw new Error('상위 업무 버전이 갱신되지 않았습니다.');
      }
    } catch {
      setParentReview({ state: 'failed' });
      setError('최신 상위 업무를 불러오지 못했습니다.');
    }
  }

  async function reloadParentReview() {
    if (!reviewedParent || pendingRef.current) return;
    pendingRef.current = true;
    setBusy(true);
    try { await readParentReview(reviewedParent); }
    finally { pendingRef.current = false; setBusy(false); }
  }

  async function readScheduleReview(previous: ReviewedSchedule) {
    try {
      const snapshot = await api<WorkspaceSnapshot>('/workspace', { cache: 'no-store' });
      const review = scheduleReviewFrom(snapshot, previous, true);
      setScheduleReview(review);
      if (review?.state === 'missing') setError(`${scheduleAnchorRole} 업무를 찾을 수 없습니다.`);
      if (review?.state === 'moved') setError(`${scheduleAnchorRole} 업무가 다른 프로젝트로 이동했습니다.`);
    } catch {
      setScheduleReview({ state: 'failed' });
      setError(`최신 ${scheduleAnchorRole} 일정과 프로젝트 작업 달력을 불러오지 못했습니다.`);
    }
  }

  async function reloadScheduleReview() {
    if (!reviewedSchedule || pendingRef.current) return;
    pendingRef.current = true;
    setBusy(true);
    setError('');
    try { await readScheduleReview(reviewedSchedule); }
    finally { pendingRef.current = false; setBusy(false); }
  }

  async function readCloneReview(source: Issue) {
    try {
      const snapshot = await api<WorkspaceSnapshot>('/workspace', { cache: 'no-store' });
      setCloneReview(cloneReviewFrom(snapshot, source) ?? { state: 'failed' });
    } catch {
      setCloneReview({ state: 'failed' });
    }
  }

  async function reloadCloneReview() {
    if (!reviewedClone || pendingRef.current) return;
    pendingRef.current = true;
    setBusy(true);
    setError('');
    try { await readCloneReview(reviewedClone); }
    finally { pendingRef.current = false; setBusy(false); }
  }

  async function readBlockedReview(source: ScheduledIssue, calendar: WorkCalendar | null) {
    try {
      const snapshot = await api<WorkspaceSnapshot>('/workspace', { cache: 'no-store' });
      setBlockedReview(blockedReviewFrom(snapshot, source, calendar, true));
    } catch {
      setBlockedReview({ state: 'failed' });
    }
  }

  async function reloadBlockedReview() {
    if (!reviewedBlocked || pendingRef.current) return;
    pendingRef.current = true;
    setBusy(true);
    setError('');
    try { await readBlockedReview(reviewedBlocked, blockedCalendar); }
    finally { pendingRef.current = false; setBusy(false); }
  }

  async function readCycleReview(previous: CycleBoardCycle) {
    try {
      const snapshot = await api<WorkspaceSnapshot>('/workspace', { cache: 'no-store' });
      setCycleReview(cycleReviewFrom(snapshot, projectId, previous, true));
    } catch {
      setCycleReview({ state: 'failed' });
    }
  }

  async function reloadCycleReview() {
    if (!reviewedCycle || pendingRef.current) return;
    pendingRef.current = true;
    setBusy(true);
    setError('');
    try { await readCycleReview(reviewedCycle); }
    finally { pendingRef.current = false; setBusy(false); }
  }

  function copyCloneDates() {
    if (!reviewedClone) return;
    dirtyRef.current = true;
    setCloneDates({
      startDate: reviewedClone.startDate ?? '',
      endDate: reviewedClone.endDate ?? '',
      dueDate: reviewedClone.dueDate ?? '',
    });
  }

  function editScheduleDate(endpoint: ScheduleDependencyEndpoint, date: string) {
    setScheduleDates(previous => ({ ...previous, [endpoint]: date }));
    if (scheduleMode && (scheduleDirection === 'predecessor' || endpoint === 'endDate')) setScheduleDatesCustomized(true);
  }

  function applyCalculatedDates(dates: ScheduleDates) {
    if (pendingRef.current || fieldsLocked || needsScheduleReview || needsBlockedReview || !selectedProject) return;
    dirtyRef.current = true;
    if (cloneMode) setCloneDates(previous => ({ ...previous, ...dates }));
    else {
      setScheduleDates(dates);
      if (scheduleMode) setScheduleDatesCustomized(true);
    }
  }

  function applySuggestedDate() {
    const suggestion = proposal.suggestion;
    if (!suggestion) return;
    dirtyRef.current = true;
    setScheduleDates(previous => {
      if ((scheduleDirection === 'predecessor' || dependencyType === 'FS') &&
          previous.startDate === previous.endDate && !scheduleDatesCustomized) {
        return { startDate: suggestion.date, endDate: suggestion.date };
      }
      return { ...previous, [suggestion.endpoint]: suggestion.date };
    });
  }

  async function reloadGitlabFollowUp() {
    if (!reviewedGitlab || !linkedPath || pendingRef.current) return;
    pendingRef.current = true;
    setBusy(true);
    try {
      const latest = await api<GitlabFollowUpPreview>(linkedPath, { cache: 'no-store' });
      if (latest.source?.id !== reviewedGitlab.source.id || latest.source.projectId !== selectedProject ||
          latest.evidence?.linkId !== reviewedGitlab.evidence.linkId) throw new Error('현재 프로젝트에서 GitLab 근거를 확인할 수 없습니다.');
      await refresh();
      setReviewedGitlab(latest);
      setNeedsGitlabReview(false);
      setError('');
      requestAnimationFrame(() => titleInput.current?.focus({ preventScroll: true }));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      pendingRef.current = false;
      setBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingRef.current || checklistPicking || !selectedProject || needsSourceReview || needsParentReview || needsScheduleReview ||
      needsCloneReview || needsBlockedReview || needsCycleReview || needsGitlabReview || (blockedMode && !blockedCalendar) || replayRejected) return;
    const replay = Boolean(attempt.current);
    if (scheduleMode && lagDays === null && !replay) return;
    const form = event.currentTarget;
    pendingRef.current = true;
    setBusy(true);
    setError('');
    let confirmed = false;
    try {
      if (reviewedSchedule && linkedPath) {
        const request = attempt.current ?? createIssueAttempt(actorId, {
          [scheduleCopy.versionField]: reviewedSchedule.issue.version,
          expectedCalendarVersion: reviewedSchedule.calendar.version,
          type: dependencyType,
          lagDays,
          issue: issuePayload(new FormData(form)),
        });
        attempt.current = request;
        const issue = await requestIssueCreation(request, selectedProject, linkedPath);
        confirmed = true;
        await refresh();
        attempt.current = null;
        setRecovering(false);
        dirtyRef.current = false;
        notify(replay ? `${issue.key} 업무의 생성 결과를 확인했습니다.` : `${issue.key} 업무를 만들고 일정에 연결했습니다.`);
        pendingRef.current = false;
        onClose();
        if (onScheduleIssueCreated) onScheduleIssueCreated(issue);
        else openIssue(issue.id);
      } else if (reviewedGitlab && linkedPath) {
        const request = attempt.current ?? createIssueAttempt(actorId, {
          expectedRevision: reviewedGitlab.revision, issue: issuePayload(new FormData(form)),
        });
        attempt.current = request;
        const issue = await requestIssueCreation(request, selectedProject, linkedPath);
        confirmed = true;
        await refresh();
        attempt.current = null;
        dirtyRef.current = false;
        pendingRef.current = false;
        onClose();
        onGitlabFollowUpCreated?.(issue);
      } else if (reviewedClone && linkedPath) {
        const request = attempt.current ?? createIssueAttempt(actorId, {
          expectedSourceVersion: reviewedClone.version,
          issue: issuePayload(new FormData(form)),
        });
        attempt.current = request;
        const result = await api<IssueCloneResult>(linkedPath, {
          method: 'POST', headers: { 'X-Actor-Id': request.actorId }, body: request.body,
        });
        const issue = result?.issue;
        const relation = result?.relation;
        const linked = relation?.type === 'related' && (
          (relation.sourceIssueId === reviewedClone.id && relation.targetIssueId === issue?.id) ||
          (relation.targetIssueId === reviewedClone.id && relation.sourceIssueId === issue?.id)
        );
        if (typeof issue?.id !== 'string' || !issue.id || issue.id === reviewedClone.id ||
          typeof issue.key !== 'string' || !issue.key || issue.projectId !== selectedProject ||
          typeof result.duplicate !== 'boolean' || (!linked && !(result.duplicate && relation === null))) {
          throw new Error('업무 복제 응답을 읽을 수 없습니다.');
        }
        confirmed = true;
        await refresh();
        attempt.current = null;
        setRecovering(false);
        dirtyRef.current = false;
        notify(replay ? `${issue.key} 업무의 생성 결과를 확인했습니다.` : `${issue.key} 복제 업무를 만들었습니다.`);
        pendingRef.current = false;
        onCloneCreated?.(issue);
        onClose();
      } else if (reviewedBlocked && blockedCalendar && linkedPath) {
        const request = attempt.current ?? createIssueAttempt(actorId, {
          expectedSourceVersion: reviewedBlocked.version,
          expectedTargetCalendarVersion: blockedCalendar.version,
          issue: issuePayload(new FormData(form)),
        });
        attempt.current = request;
        const result = await api<IssueBlockedCreationResult>(linkedPath, {
          method: 'POST', headers: { 'X-Actor-Id': request.actorId }, body: request.body,
        });
        const { issue, relation } = result ?? {};
        const linked = relation?.type === 'blocks' && relation.sourceIssueId === reviewedBlocked.id &&
          relation.targetIssueId === issue?.id;
        if (typeof issue?.id !== 'string' || !issue.id || issue.id === reviewedBlocked.id ||
          typeof issue.key !== 'string' || !issue.key || issue.projectId !== selectedProject ||
          typeof result.duplicate !== 'boolean' || (!linked && !(result.duplicate && relation === null))) {
          throw new Error('업무와 차단 관계의 생성 응답을 읽을 수 없습니다.');
        }
        confirmed = true;
        await refresh();
        attempt.current = null;
        setRecovering(false);
        dirtyRef.current = false;
        notify(!linked ? `${issue.key} 업무를 확인했습니다. 현재 차단 관계가 없습니다.`
          : replay ? `${issue.key} 업무와 차단 관계의 저장 결과를 확인했습니다.`
            : `${issue.key} 업무를 만들고 ${reviewedBlocked.key}의 차단 대상으로 연결했습니다.`);
        pendingRef.current = false;
        onClose();
        onBlockedIssueCreated?.(issue);
      } else if (linkedPath) {
        const commentReference: DocumentFollowUpCommentSource | undefined = sourceComment && {
          commentId: sourceComment.id, revisionId: sourceComment.source.revisionId,
        };
        const request = attempt.current ?? {
          actorId,
          body: JSON.stringify({
            requestId: newRequestId(),
            ...(reviewedParent ? { expectedParentVersion: reviewedParent.version } : {
              expectedDocumentVersion: sourceVersion,
              ...(commentReference ? { sourceComment: commentReference } : { sourceSelection }),
            }),
            issue: issuePayload(new FormData(form)),
          }),
        };
        attempt.current = request;
        const result = await api<DocumentFollowUpResult | IssueChildCreationResult>(linkedPath, {
          method: 'POST', headers: { 'X-Actor-Id': request.actorId }, body: request.body,
        });
        const documentLink = result && typeof result === 'object' && 'link' in result ? result.link : undefined;
        const pinned = documentLink?.documentSource;
        if (!result?.issue?.id ||
          (reviewedParent && (result.issue.parentId !== reviewedParent.id || result.issue.projectId !== reviewedParent.projectId)) ||
          (sourceDocument && (documentLink?.issueId !== result.issue.id || documentLink.documentId !== sourceDocument.id)) ||
          (checklistMode && (!sourceSelection || !pinned?.revisionId || pinned.from !== sourceSelection.from ||
            pinned.to !== sourceSelection.to || pinned.text !== sourceSelection.text)) ||
          (sourceComment && (pinned?.revisionId !== sourceComment.source.revisionId || pinned?.from !== sourceComment.source.from ||
            pinned?.to !== sourceComment.source.to || pinned?.text !== sourceComment.source.text))) {
          throw new Error('업무 생성 응답을 읽을 수 없습니다.');
        }
        confirmed = true;
        await refresh();
        attempt.current = null;
        setRecovering(false);
        notify(reviewedParent ? `${result.issue.key} 하위 업무를 만들었습니다.` : `${result.issue.key} 후속 업무를 문서에 연결했습니다.`);
        dirtyRef.current = false;
        onClose();
      } else {
        const request = attempt.current ?? createIssueAttempt(actorId, cycleBoardCreation ? {
          targetCycle: reviewedCycle ? { id: reviewedCycle.id, expectedVersion: reviewedCycle.version } : null,
          issue: issuePayload(new FormData(form)),
        } satisfies Omit<CycleBoardCreateInput, 'requestId'> : issuePayload(new FormData(form)));
        attempt.current = request;
        const path = cycleBoardCreation ? `/projects/${encodeURIComponent(projectId)}/cycle-board/issues` : undefined;
        const issue = await requestIssueCreation(request, selectedProject, path);
        confirmed = true;
        await refresh();
        attempt.current = null;
        dirtyRef.current = false;
        pendingRef.current = false;
        if (cycleBoardCreation) cycleBoardCreation.onCreated(issue);
        else {
          notify('새 업무를 만들었습니다.');
          onClose();
          openIssue(issue.id);
        }
      }
    } catch (cause) {
      const status = cause instanceof ApiError ? cause.status : null;
      const details = cause instanceof ApiError ? cause.details as { currentVersion?: unknown; reason?: unknown } | undefined : undefined;
      const definiteFailure = !confirmed && (usesIssueReceipt ? isDefiniteIssueCreationFailure(cause, replay)
        : status !== null && status >= 400 && status < 500 && (!childMode || (status !== 408 && status !== 429)));
      if (attempt.current && !definiteFailure) {
        setRecovering(true);
        if (confirmed) {
          setError(childMode ? '하위 업무를 만들었습니다. 목록을 다시 불러와 결과를 확인해 주세요.'
            : scheduleMode ? `${scheduleRole} 업무를 만들었습니다. 일정을 다시 불러와 연결 결과를 확인해 주세요.`
            : cloneMode ? '복제 업무를 만들었습니다. 관련 업무를 다시 불러와 결과를 확인해 주세요.'
            : blockedMode ? '업무를 만들었습니다. 차단 관계를 다시 불러와 결과를 확인해 주세요.'
            : sourceDocument ? '업무를 만들었습니다. 목록을 다시 불러와 연결 결과를 확인해 주세요.'
            : '업무를 만들었습니다. 목록을 다시 불러와 결과를 확인해 주세요.');
        } else {
          setError(usesIssueReceipt && replay && (status === 401 || status === 403)
            ? '팀 접속을 확인한 뒤 같은 요청으로 결과를 다시 확인해 주세요.'
            : '업무 생성 결과를 확인하지 못했습니다. 같은 요청으로 결과를 다시 확인해 주세요.');
        }
      } else {
        const templateRejected = typeof details?.reason === 'string' && details.reason.startsWith('issue-template-');
        const staleChecklistSource = checklistMode &&
          (details?.reason === 'source_selection_changed' || Number.isSafeInteger(details?.currentVersion));
        if (!replay || linkedCreation || templateRejected) attempt.current = null;
        setRecovering(false);
        if (reviewedSchedule && status === 409 && (details?.reason === scheduleCopy.changed || details?.reason === 'calendar_changed')) {
          setError(errorMessage(cause));
          await readScheduleReview(reviewedSchedule);
        } else if (reviewedSchedule && status === 404 && details?.reason === scheduleCopy.missing) {
          setScheduleReview({ state: 'missing' });
          setError(errorMessage(cause));
        } else if (reviewedGitlab && (details?.reason === 'gitlab_follow_up_changed' || details?.reason === 'gitlab_follow_up_unavailable')) {
          setNeedsGitlabReview(true);
          setError(errorMessage(cause));
          requestAnimationFrame(() => dialog.current?.focus({ preventScroll: true }));
        } else if (reviewedClone && ((status === 409 && details?.reason === 'source_version_changed') ||
          (status === 404 && details?.reason === 'source_missing'))) {
          await readCloneReview(reviewedClone);
        } else if (reviewedBlocked && status === 409 && (details?.reason === 'source_version_changed' || details?.reason === 'calendar_changed')) {
          await readBlockedReview(reviewedBlocked, blockedCalendar);
        } else if (reviewedBlocked && status === 404 && details?.reason === 'source_missing') {
          setBlockedReview({ state: 'missing' });
        } else if (reviewedCycle && status === 409 && details?.reason === 'target_cycle_changed') {
          attempt.current = null;
          await readCycleReview(reviewedCycle);
          requestAnimationFrame(() => dialog.current?.focus({ preventScroll: true }));
        } else if (templateRejected) {
          setTemplateError(errorMessage(cause));
        } else if (sourceDocument && status === 409 && (!replay || staleChecklistSource)) {
          await refresh().catch(() => {});
          setVersionConflict(true);
          setError(errorMessage(cause));
        } else if (replay) {
          setReplayRejected(true);
          setError(linkedCreation ? `${errorMessage(cause)} ${confirmationLocation}을 확인해 주세요.` : errorMessage(cause));
          if (usesIssueReceipt) requestAnimationFrame(() => closeButton.current?.focus({ preventScroll: true }));
        } else if (reviewedParent && status === 404 && details?.reason === 'parent_missing') {
          setParentReview({ state: 'missing' });
          setError(errorMessage(cause));
        } else if (reviewedParent && status === 409 && Number.isSafeInteger(details?.currentVersion)) {
          await readParentReview(reviewedParent);
        } else {
          setError(errorMessage(cause));
          if (!linkedCreation) requestAnimationFrame(() => submitButton.current?.focus());
        }
      }
    } finally {
      pendingRef.current = false;
      setBusy(false);
    }
  }

  function keyboard(event: KeyboardEvent<HTMLElement>) {
    if (!linkedCreation && !cycleBoardCreation && !fromBoard) return;
    if (event.key === 'Escape' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's')) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') close();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary') ?? [])
      .filter(element => element.getClientRects().length > 0);
    if (!controls.length) { event.preventDefault(); return; }
    const first = controls[0], last = controls[controls.length - 1];
    if (document.activeElement === dialog.current) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  const dateFields = <>
    {(['startDate', 'endDate'] as const).map(endpoint => <label key={endpoint} className="issue-form-label">{SCHEDULE_DATE_LABELS[endpoint]}
      <input type="date" name={endpoint} className="field" value={rangeDates[endpoint]}
        onChange={event => {
          const date = event.target.value;
          if (cloneMode) setCloneDates(previous => ({ ...previous, [endpoint]: date }));
          else editScheduleDate(endpoint, date);
        }} />
    </label>)}
  </>;
  const dateRangePicker = rangeMath && <WorkingDayRangePicker calendarMath={rangeMath}
    startDate={rangeDates.startDate || null} endDate={rangeDates.endDate || null}
    onApply={applyCalculatedDates} disabled={fieldsLocked || needsScheduleReview || needsBlockedReview} />;
  const availableProjects = reviewedBlocked ? data.projects.filter(project => project.id !== reviewedBlocked.projectId) : data.projects;

  return <div className="issue-modal-overlay" style={checklistPicking ? { display: 'none' } : undefined} inert={checklistPicking}
    onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section ref={dialog} tabIndex={handlesNestedNavigation ? -1 : undefined} onKeyDown={keyboard} className="issue-create-modal" role="dialog" aria-modal="true" aria-labelledby="new-issue-title">
      <form onSubmit={submit} onChange={() => { dirtyRef.current = true; }}>
        <header><div>
          {!linkedCreation && <span className="feature-eyebrow">NEW ISSUE</span>}
          <h2 id="new-issue-title">{childMode ? '하위 업무 만들기' : scheduleMode ? `${scheduleRole} 업무 만들기` : cloneMode ? '업무 복제' : blockedMode ? '새 차단 대상 업무' : gitlabFollowUpMode ? 'GitLab 후속 업무 만들기' : sourceDocument ? '후속 업무 만들기' : '새 업무 만들기'}</h2>
          {sourceDocument && <p className="issue-follow-up-source">연결할 문서 · <strong>{sourceDocument.title}</strong></p>}
          {reviewedParent && <p className="issue-follow-up-source">상위 업무 · <strong>{reviewedParent.key} {reviewedParent.title}</strong></p>}
          {reviewedSchedule && <p className="issue-follow-up-source">{scheduleAnchorRole} 업무 · <strong>{reviewedSchedule.issue.key} {reviewedSchedule.issue.title}</strong></p>}
          {reviewedClone && <p className="issue-follow-up-source">원본 업무 · <strong>{reviewedClone.key} {reviewedClone.title}</strong></p>}
          {reviewedGitlab && <p className="issue-follow-up-source">원본 업무 · <strong>{reviewedGitlab.source.key} {reviewedGitlab.source.title}</strong></p>}
          {reviewedBlocked && <p className="issue-follow-up-source">차단하는 업무 · <strong>{reviewedBlocked.key} {reviewedBlocked.title}</strong></p>}
          {cycleBoardCreation && <p className="issue-follow-up-source">등록 위치 · <strong>{reviewedCycle?.name ?? '백로그'}</strong></p>}
        </div><button ref={closeButton} className="issue-icon-button" type="button" disabled={busy} onClick={close} aria-label="닫기"><X size={19} /></button></header>
        {reviewedGitlab && <section className="issue-follow-up-passage" aria-label="저장할 GitLab 근거">
          <a href={reviewedGitlab.evidence.href} target="_blank" rel="noopener noreferrer">{reviewedGitlab.evidence.label}</a>
          <span> · {reviewedGitlab.evidence.state}</span>
        </section>}
        {sourceSelection && <section className="issue-follow-up-passage" aria-label={checklistMode ? '선택한 체크리스트 항목' : '선택한 본문'}>
          <strong>{checklistMode ? '선택한 체크리스트 항목' : '선택한 본문'}</strong>
          <blockquote>{sourceSelection.text}</blockquote>
        </section>}
        {sourceComment && <section className="issue-follow-up-passage" aria-label="댓글 원문">
          <strong>댓글 원문</strong>
          <blockquote>{sourceComment.source.text}</blockquote>
        </section>}
        <fieldset disabled={fieldsLocked} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <div className="issue-create-fields">
            <label className="issue-form-label">프로젝트
              <select name="projectId" className="field" value={selectedProject} autoFocus={blockedMode}
                disabled={childMode || scheduleMode || cloneMode || gitlabFollowUpMode || Boolean(sourceDocument?.projectId) || Boolean(cycleBoardCreation) || fromBoard} onChange={event => {
                const next = event.target.value;
                setSelectedProject(next);
                setSelectedType(initialIssueType(data, next));
                setSelectedStatus(projectWorkflow(data, next).initialStatusId);
                setAppliedTemplate(null);
                setTemplateError('');
                setTemplateNotice('');
                if (reviewedBlocked) {
                  const calendar = calendarFor(data, next);
                  setBlockedCalendar(calendar);
                  setBlockedReview(current => current?.state === 'available' ? { ...current, calendar }
                    : current?.state === 'project_missing' ? null : current);
                  setError('');
                }
              }} required>
                {(blockedMode || (sourceDocument && !sourceDocument.projectId)) && <option value="" disabled>프로젝트를 선택하세요</option>}
                {availableProjects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}
              </select>
            </label>
            {(!linkedCreation || blockedMode) && selectedProject && <IssueTemplatePicker key={`${selectedProject}:${actorId}`}
              projectId={selectedProject} applied={appliedTemplate} error={templateError} notice={templateNotice}
              onApply={applyTemplate} onDetach={() => {
                setAppliedTemplate(null);
                setTemplateError('');
                setTemplateNotice('');
              }} />}
            <label className="issue-form-label">업무 제목<input ref={titleInput} autoFocus={!blockedMode} className="field issue-title-input" name="title" placeholder="무엇을 해야 하나요?" maxLength={300} defaultValue={initialTitle} required /></label>
            {scheduleMode && <section className="issue-successor-schedule" aria-label={`${scheduleAnchorRole} 일정 연결`}>
              <div className="issue-form-grid">
                <label className="issue-form-label">연결 유형<select className="field" aria-label="연결 유형" value={dependencyType} onChange={event => {
                  if (isDependencyType(event.target.value)) setDependencyType(event.target.value);
                }}>
                  {DEPENDENCY_TYPES.map(type => <option key={type} value={type}>{DEPENDENCY_LABELS[type]} ({type})</option>)}
                </select></label>
                <label className="issue-form-label">근무일 간격<input className="field" aria-label="근무일 간격" type="number" min={-MAX_DEPENDENCY_LAG_DAYS} max={MAX_DEPENDENCY_LAG_DAYS} step={1} required value={lag} onChange={event => setLag(event.target.value)} /></label>
              </div>
              <div className="issue-successor-proposal">
                <div aria-live="polite">
                  {proposal.suggestion && <span>제안 {SCHEDULE_DATE_LABELS[proposal.suggestion.endpoint]} <strong>{proposal.suggestion.date}</strong></span>}
                  {proposal.message && <span>{proposal.message}</span>}
                  {lagDays === null && <span>근무일 간격을 -3,650부터 3,650까지 정수로 입력해 주세요.</span>}
                </div>
                {proposal.suggestion && <button type="button" className="btn" disabled={needsScheduleReview || scheduleDates[proposal.suggestion.endpoint] === proposal.suggestion.date}
                  onClick={applySuggestedDate}>제안 날짜 적용</button>}
              </div>
              {proposal.warning && <p className="issue-successor-warning" role="status">{proposal.warning}</p>}
              <div className="issue-form-grid">{dateFields}</div>
              {dateRangePicker}
            </section>}
            {reviewedBlocked && <section className="issue-successor-schedule" aria-label="차단 기준 일정">
              <div className="issue-successor-proposal">
                <div aria-live="polite">
                  <span>차단하는 업무의 종료일 <strong>{reviewedBlocked.endDate ?? '미정'}</strong></span>
                  {blockedProposal.suggestion && <div>대상 달력의 제안 시작일 <strong>{blockedProposal.suggestion.date}</strong></div>}
                  {blockedProposal.message && <div>{blockedProposal.message}</div>}
                </div>
                {blockedProposal.suggestion && <button type="button" className="btn"
                  disabled={needsBlockedReview || scheduleDates.startDate === blockedProposal.suggestion.date}
                  onClick={() => {
                    const suggestion = blockedProposal.suggestion;
                    if (!suggestion) return;
                    dirtyRef.current = true;
                    editScheduleDate('startDate', suggestion.date);
                  }}>제안 시작일 적용</button>}
              </div>
              {blockedProposal.warning && <p className="issue-successor-warning" role="status">{blockedProposal.warning}</p>}
              <div className="issue-form-grid">{dateFields}</div>
              {dateRangePicker}
            </section>}
            <IssueDescriptionEditor value={description} format={descriptionFormat} name="description" disabled={fieldsLocked}
              onChange={value => { dirtyRef.current = true; setDescription(value); }}
              onFormatChange={format => { dirtyRef.current = true; setDescriptionFormat(format); }} />
            <div className="issue-form-grid">
              <label className="issue-form-label">유형<IssueTypeSelect data={data} projectId={selectedProject} value={selectedType} onChange={setSelectedType} name="type" /></label>
              <label className="issue-form-label">상태<select name="status" aria-label="새 업무 상태" className="field" value={selectedStatus} onChange={event => setSelectedStatus(event.target.value)}>{states.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}</select></label>
              <label className="issue-form-label">우선순위<select name="priority" className="field" value={priority} onChange={event => setPriority(event.target.value as Priority)}>{Object.entries(PRIORITY).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label>
              <label className="issue-form-label">담당자<select className="field" name="assigneeId" defaultValue={cloneIssue?.assigneeId ?? initialBoardAssigneeId ?? ''}><option value="">미지정</option>{data.users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label>
              {!scheduleMode && !blockedMode && dateFields}
              <label className="issue-form-label">요청자<IssueReporterSelect value={reporterId === undefined ? actorId || undefined : reporterId}
                users={data.users} onChange={value => setReporterId(value === actorId ? undefined : value)} /></label>
            </div>
            {!scheduleMode && !blockedMode && dateRangePicker}
            {reviewedClone && <div><button type="button" className="btn" disabled={needsCloneReview || !(reviewedClone.startDate || reviewedClone.endDate || reviewedClone.dueDate)}
              onClick={copyCloneDates}>원본 일정 복사</button></div>}
            <CustomFields data={data} projectId={selectedProject} issueType={selectedType} status={selectedStatus} values={formValues} onChange={next => {
              dirtyRef.current = true;
              if (templateFieldIds) {
                const staged = Object.fromEntries(Object.entries(values).filter(([id]) => !Object.hasOwn(formValues, id)));
                setValuesByProject(previous => ({ ...previous, [selectedProject]: { ...staged, ...next } }));
                setTemplateFieldIdsByProject(previous => ({ ...previous, [selectedProject]: templateFieldIds
                  .filter(id => next[id] === formValues[id]) }));
              } else {
                setValuesByProject(previous => ({ ...previous, [selectedProject]: next }));
              }
            }} disabled={fieldsLocked} requiredFields={required} />
            {required.length > 0 && <p className="issue-section-empty">필수 속성: {requiredFieldLabels(data, selectedProject, required).join(', ')}</p>}
            <details open={cloneMode || required.some(field => ['dueDate', 'estimate', 'labels', 'collaboratorIds', 'cycle', 'module', 'release'].includes(field) || (field === 'parentId' && !childMode))}>
              <summary className="issue-section-caption">추가 속성</summary>
              <div className="issue-form-grid">
                <label className="issue-form-label">목표 마감일<input className="field" type="date" name="dueDate" value={cloneMode ? cloneDates.dueDate : undefined}
                  onChange={event => {
                    const dueDate = event.target.value;
                    if (cloneMode) setCloneDates(previous => ({ ...previous, dueDate }));
                  }} /></label>
                <label className="issue-form-label">예상 소요 (포인트)<input className="field" type="number" name="estimate" min="0" step={cloneMode ? 'any' : '0.5'} defaultValue={cloneIssue?.estimate ?? undefined} /></label>
                <label className="issue-form-label">계획 작업 시간 (분)<input className="field" type="number" name="plannedEffortMinutes" min={0} max={MAX_PLANNED_EFFORT_MINUTES} step={1} defaultValue={cloneIssue?.plannedEffortMinutes ?? undefined} /></label>
                <label className="issue-form-label">라벨{cloneMode
                  ? <textarea className="field" name="labels" rows={2} placeholder="한 줄에 하나" defaultValue={cloneLabels} />
                  : <input ref={labelInput} className="field" name="labels" placeholder="쉼표로 구분" />}</label>
                {!childMode && <label className="issue-form-label">상위 업무<select className="field" name="parentId" key={selectedProject}><option value="">없음</option>{data.issues.filter(issue => issue.projectId === selectedProject).map(issue => <option key={issue.id} value={issue.id}>{issue.key} · {issue.title}</option>)}</select></label>}
                {(['cycle', 'module', 'release'] as const).map(field => cycleBoardCreation && field === 'cycle' ? null
                  : <label className="issue-form-label" key={field}>{REQUIRED_FIELD_LABELS[field]}<PlanningSelect data={data} projectId={selectedProject} kind={field} name={`${field}Id`} /></label>)}
                <label className="issue-form-label">참여자<select className="field" name="collaboratorIds" multiple defaultValue={cloneIssue?.collaboratorIds}>{data.users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label>
              </div>
            </details>
            {!linkedCreation && !cycleBoardCreation && error && <div className="issue-form-error" role="alert">{error}</div>}
          </div>
        </fieldset>
        {cycleBoardCreation && (error || needsCycleReview) && <div className="issue-follow-up-error">
          <div className="issue-form-error" role="alert">{error || cycleReviewMessage}</div>
          {needsCycleReview && pendingCycleReview?.state === 'available' && <>
            <span className="issue-follow-up-source">{pendingCycleReview.cycle.name} · {pendingCycleReview.cycle.status === 'active' ? '진행 중' : '계획'}</span>
            <button type="button" className="btn" onClick={() => {
              setReviewedCycle(pendingCycleReview.cycle);
              setCycleReview(null);
              setError('');
              titleInput.current?.focus({ preventScroll: true });
            }}>최신 사이클 사용</button>
          </>}
          {needsCycleReview && pendingCycleReview?.state === 'failed' && <button type="button" className="btn"
            onClick={() => void reloadCycleReview()}>최신 사이클 불러오기</button>}
          {needsCycleReview && (pendingCycleReview?.state === 'missing' || pendingCycleReview?.state === 'closed') &&
            <button type="button" className="btn" onClick={() => {
              setReviewedCycle(null);
              setCycleReview(null);
              setError('');
              titleInput.current?.focus({ preventScroll: true });
            }}>백로그로 등록 위치 변경</button>}
        </div>}
        {linkedCreation && linkedError && <div className="issue-follow-up-error">
          <div className="issue-form-error" role="alert">{linkedError}</div>
          {needsGitlabReview && <button type="button" className="btn" disabled={busy}
            onClick={() => void reloadGitlabFollowUp()}>최신 GitLab 근거 확인</button>}
          {checklistMode && needsSourceReview && onReselectChecklist && <button type="button" className="btn" disabled={busy}
            onClick={onReselectChecklist}>최신 체크리스트 항목 다시 선택</button>}
          {!checklistMode && canReviewVersion && <button type="button" className="btn" disabled={busy} onClick={() => {
            setSourceVersion(currentDocument.version);
            setSourceSelection(undefined);
            setVersionConflict(false);
            setError('');
          }}>{sourceSelection ? '인용 없이 최신 문서 사용' : `최신 문서 버전 ${currentDocument.version} 사용`}</button>}
          {parentReview?.state === 'available' && <>
            <span className="issue-follow-up-source">{parentReview.issue.key} {parentReview.issue.title} · 버전 {parentReview.issue.version}</span>
            <button type="button" className="btn" disabled={busy} onClick={() => {
              setReviewedParent(parentReview.issue);
              setParentReview(null);
              setError('');
              titleInput.current?.focus({ preventScroll: true });
            }}>최신 상위 업무 사용</button>
          </>}
          {parentReview?.state === 'failed' && <button type="button" className="btn" disabled={busy} onClick={() => void reloadParentReview()}>상위 업무 다시 불러오기</button>}
          {needsCloneReview && pendingCloneReview?.state === 'available' && <>
            <div className="issue-successor-review">
              <strong>{pendingCloneReview.issue.key} {pendingCloneReview.issue.title}</strong>
              <span>버전 {pendingCloneReview.issue.version}</span>
            </div>
            <button type="button" className="btn" onClick={() => {
              setReviewedClone(pendingCloneReview.issue);
              setCloneReview(null);
              setError('');
              titleInput.current?.focus({ preventScroll: true });
            }}>최신 원본 버전 확인</button>
          </>}
          {needsCloneReview && pendingCloneReview?.state !== 'available' &&
            <button type="button" className="btn" onClick={() => void reloadCloneReview()}>원본 다시 불러오기</button>}
          {needsScheduleReview && pendingScheduleReview?.state === 'available' && <>
            <div className="issue-successor-review">
              <strong>{pendingScheduleReview.schedule.issue.key} {pendingScheduleReview.schedule.issue.title}</strong>
              <span>시작일 {pendingScheduleReview.schedule.issue.startDate ?? '미정'} · 종료일 {pendingScheduleReview.schedule.issue.endDate ?? '미정'}</span>
              <span>{pendingScheduleReview.schedule.calendar.name} · 버전 {pendingScheduleReview.schedule.calendar.version}</span>
            </div>
            <button type="button" className="btn" disabled={busy} onClick={() => {
              setReviewedSchedule(pendingScheduleReview.schedule);
              setScheduleReview(null);
              setError('');
              titleInput.current?.focus({ preventScroll: true });
            }}>최신 {scheduleAnchorRole} 일정 사용</button>
          </>}
          {needsScheduleReview && pendingScheduleReview && pendingScheduleReview.state !== 'available' &&
            <button type="button" className="btn" disabled={busy} onClick={() => void reloadScheduleReview()}>{scheduleAnchorRole} 일정 다시 불러오기</button>}
          {needsBlockedReview && pendingBlockedReview?.state === 'available' && <>
            <div className="issue-successor-review">
              <strong>{pendingBlockedReview.issue.key} {pendingBlockedReview.issue.title}</strong>
              <span>차단하는 업무의 종료일 {pendingBlockedReview.issue.endDate ?? '미정'} · 버전 {pendingBlockedReview.issue.version}</span>
              {pendingBlockedReview.calendar && <span>{pendingBlockedReview.calendar.name} · 버전 {pendingBlockedReview.calendar.version}</span>}
            </div>
            <button type="button" className="btn" disabled={busy} onClick={() => {
              setReviewedBlocked(pendingBlockedReview.issue);
              setBlockedCalendar(pendingBlockedReview.calendar);
              setBlockedReview(null);
              setError('');
              titleInput.current?.focus({ preventScroll: true });
            }}>최신 차단 기준 사용</button>
          </>}
          {needsBlockedReview && pendingBlockedReview?.state === 'failed' &&
            <button type="button" className="btn" disabled={busy} onClick={() => void reloadBlockedReview()}>차단 기준 다시 불러오기</button>}
        </div>}
        <footer>
          {!scheduleMode && !blockedMode && <span className="muted">{gitlabFollowUpMode ? '원본 업무의 관련 업무로 연결하고 위 GitLab 근거를 설명에 기록합니다.'
            : sourceDocument ? '생성한 업무는 문서의 연결 목록에서 열 수 있어요.' : childMode ? '생성한 업무는 상위 업무의 하위 목록에서 열 수 있어요.'
              : cloneMode ? '복제 업무는 원본의 관련 업무 목록에서 열 수 있어요.' : '상세 속성은 생성 후에도 수정할 수 있어요.'}</span>}
          <button className="btn btn-ghost" type="button" disabled={busy} onClick={close}>취소</button>
          <button ref={submitButton} className="btn btn-primary" type="submit" disabled={busy || !selectedProject || !selectedType ||
            needsSourceReview || needsParentReview || needsScheduleReview || needsCloneReview || needsBlockedReview || needsCycleReview || needsGitlabReview || replayRejected ||
            (blockedMode && !blockedCalendar) || (scheduleMode && lagDays === null && !recovering)}>
            {busy ? '만드는 중…' : recovering ? '업무 생성 결과 다시 확인' : <><Plus size={16} /> {sourceDocument || gitlabFollowUpMode ? '업무 만들고 연결' : childMode ? '하위 업무 만들기' : scheduleMode ? '업무 만들고 일정 연결' : cloneMode ? '복제 업무 만들기' : blockedMode ? '업무 만들고 차단 관계 연결' : '업무 만들기'}</>}
          </button>
        </footer>
      </form>
    </section>
  </div>;
}
