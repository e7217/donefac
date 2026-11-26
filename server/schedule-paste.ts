import { createHash, randomUUID } from 'node:crypto';
import type { Express, Request } from 'express';
import { CalendarError, MAX_WORKING_DURATION_DAYS, calculateWorkingDateRange, calendarDate, calendarDay, createCalendarMath, isCalendarDate } from '../shared/calendar.js';
import { traceGanttHierarchy } from '../shared/gantt-hierarchy-focus.js';
import { isRelationId } from '../shared/issue-relations.js';
import { MAX_SCHEDULE_BLOCKER_LINKS, MAX_SCHEDULE_BULK_DATE_ISSUES, MAX_SCHEDULE_BULK_LINK_ISSUES, MAX_SCHEDULE_MANUAL_ISSUES, MAX_SCHEDULE_ROW_DEPENDENCY_EDITS, SCHEDULE_BLOCKER_LINK_PAGE_SIZE, type Dependency, type Issue, type ScheduleBlockerLinkCandidate, type ScheduleBlockerLinkPage, type ScheduleBulkChainInput, type ScheduleBulkDateChanges, type ScheduleBulkDateInput, type ScheduleBulkLinkAction, type ScheduleBulkLinkDateEdit, type ScheduleBulkLinkInput,
  type ScheduleAnchorChange, type ScheduleChange, type ScheduleManualPreviewInput, type SchedulePasteApplyResult, type SchedulePasteDependencyChange, type SchedulePasteDependencyPair, type SchedulePasteKeyMapping, type SchedulePastePreview, type SchedulePreview,
  type ScheduleRowDependencyEdit, type ScheduleRowEditInput, type ScheduleSheetChoices, type ScheduleTeamBlockerApplyResult, type ScheduleTeamBlockerInput, type ScheduleTeamBlockerPreview,
  type ProjectWorkflow, type TeamScheduleBlocker, type WorkCalendar } from '../shared/types.js';
import { DEPENDENCY_ENDPOINTS, SCHEDULE_DATE_LABELS, TEAM_BLOCKER_SCHEDULE_RULE, checkDependencySchedule, dependencyGuardFields, isDependencyLag, isDependencyType } from '../shared/schedule-dependencies.js';
import { MAX_WORKLOAD_LEVEL_DEPENDENCIES, MAX_WORKLOAD_LEVEL_ISSUES } from '../shared/workload-leveling.js';
import { AutomaticScheduleError, AUTO_PREVIEW_TTL_MS, AUTO_RESULT_RETENTION_MS, calculateFixedFollowUpSchedule, type AutomaticScheduleMutation, type ScheduleUndoOrigin } from './automatic-schedule.js';
import { addsScheduleDependencyPair, dependencyPair, hasScheduleDependencyCycle, projectScheduleDependencies, type ScheduleDependencyMutation } from './schedule-dependency-changes.js';
import { readIssueSearchAliases } from './issue-search-aliases.js';
import { parseSchedulePaste, SCHEDULE_PASTE_MAX_ROWS, type SchedulePasteRow } from './schedule-paste-parser.js';
import { mergeScheduleSheetLink, scheduleSheetCellReviewer, unchangedScheduleSheetLink } from './schedule-sheet-merge.js';
import { calculateTeamFollowUpSchedule, teamBatchFollowUpScope, TeamFollowUpScheduleError } from './team-follow-up-schedule.js';
import type { Store } from './store.js';

export class SchedulePasteError extends Error {
  constructor(public status: number, message: string, public details?: { reason: 'schedule_preview_stale' | 'project_changed' } | { currentVersion: number }) { super(message); }
}

interface ScheduleVersions {
  calendar: number;
  workflow: number;
  schema: number;
}

export type ScheduleDateMutation = AutomaticScheduleMutation & Partial<Pick<Issue, 'dueDate'>>;
type TeamBlockerPair = Pick<ScheduleTeamBlockerInput, 'source' | 'target'>;
type TeamFollowUpReview = Pick<SchedulePastePreview, 'changes' | 'errors' | 'followUpIssueIds'>;

interface ScheduleReviewHooks {
  versions(projectId: string): ScheduleVersions;
  calendar(projectId: string): WorkCalendar;
  warnings(issues: Issue[], dependencies: Dependency[]): string[];
  teamBlockers(issueIds: readonly string[]): TeamScheduleBlocker[];
  isTerminal(issue: Issue): boolean;
}

interface PasteHooks extends ScheduleReviewHooks {
  actor(request: Request): string;
  workflow(projectId: string): ProjectWorkflow;
  validateChange(issue: Issue, change: ScheduleDateMutation): string | null;
  projectBlockers(projectIds: readonly string[] | null): TeamScheduleBlocker[];
  directBlockers(targetId: string): TeamScheduleBlocker[];
  commitChanges(request: Request, changes: ScheduleDateMutation[], dependencies: Dependency[], linkChanges: ScheduleDependencyMutation[],
    origin: ScheduleUndoOrigin): SchedulePasteApplyResult;
  commitTeamBlocker(request: Request, pair: TeamBlockerPair, changes: ScheduleDateMutation[], dependencies: Dependency[]): ScheduleTeamBlockerApplyResult;
}

type ScheduleScope = Pick<SchedulePastePreview, 'projectId' | 'projectIds'>;

interface ScheduleState {
  issues: Issue[];
  dependencies: Dependency[];
}

type ScheduleKeyBinding = Pick<Issue, 'id' | 'projectId' | 'key'>;
type ResolvedScheduleKeyBinding = ScheduleKeyBinding & Pick<SchedulePasteKeyMapping, 'inputKey' | 'source' | 'currentKeyConflict'>;

interface PasteProposal extends ScheduleScope {
  id: string;
  actorId: string;
  removeAfter: string;
  issueIds: string[];
  keyBindings?: ScheduleKeyBinding[];
  resolvedKeyBindings?: ResolvedScheduleKeyBinding[];
  hierarchyId?: string;
  hierarchyIssueIds?: string[];
  guard: string;
  changes: ScheduleDateMutation[];
  linkChanges?: ScheduleDependencyMutation[];
  followUpIssueIds?: string[];
  followUpWarnings?: string[];
  missingDateWarnings?: string[];
  blockerRelations?: ScheduleBlockerLinkCandidate[];
  incomingTeamBlockerGuard?: string | [issueId: string, hash: string][];
  teamBlockerGuard?: string;
  teamBlockerWarnings?: string[];
  teamFollowUp?: { anchors: ScheduleAnchorChange[]; successorIds?: string[]; guard: string };
  teamBlocker?: TeamBlockerPair;
  kind?: 'bulk-dates' | 'bulk-links' | 'blocker-links' | 'row-edit' | 'manual-edit' | 'team-blocker-edit' | 'issue-save';
  issueSaveStatus?: string;
  result?: SchedulePasteApplyResult;
}

type ProposalDraft = Pick<PasteProposal, 'actorId' | 'issueIds' | 'resolvedKeyBindings' | 'hierarchyId' | 'hierarchyIssueIds' |
  'changes' | 'linkChanges' | 'kind' | 'followUpIssueIds' | 'followUpWarnings' | 'missingDateWarnings' | 'blockerRelations' |
  'incomingTeamBlockerGuard' | 'teamBlocker' | 'issueSaveStatus' | 'teamFollowUp'>;

type DependencyCandidate = { line: number; predecessor: Issue; successor: Issue; projectId?: string };
type ScopedBlockerReference = Pick<TeamScheduleBlocker, 'id' | 'version'> & { projectId: string };
type IncomingTeamBlocker = { relation: TeamScheduleBlocker; source: Issue };

const table = 'schedule_paste_previews';
const after = (ms: number) => new Date(Date.now() + ms).toISOString();
const dateFields = { startDate: '시작일', endDate: '종료일', dueDate: '목표 마감일' };
const dateKeys = ['startDate', 'endDate', 'dueDate'] as const;

function incomingTeamBlockerGuard(blockers: IncomingTeamBlocker[]): string {
  const fields = blockers.map(({ relation, source }) => [relation.id, relation.sourceIssueId, relation.targetIssueId,
    relation.version, relation.origin ?? 'teamspace', source.projectId, source.version, source.status, source.endDate]);
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

function missingTeamBlockerDates(source: Issue, target: Issue, check: Extract<ReturnType<typeof checkDependencySchedule>, { kind: 'missing' }>): string {
  const pending = [!check.predecessorDate ? `${source.key}의 종료일` : null, !check.successorDate ? `${target.key}의 시작일` : null];
  return `프로젝트 간 차단 관계 ${source.key} → ${target.key} · ${pending.filter(Boolean).join(' 및 ')}을 확인해 주세요.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 200;
}

function isVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function parseScheduleIssue(raw: unknown): ScheduleRowEditInput['issue'] {
  if (!isRecord(raw) || Object.keys(raw).length !== 2 || !isId(raw.id) || !isVersion(raw.expectedVersion)) {
    throw new SchedulePasteError(400, '선택한 업무 ID와 조회 당시 버전을 확인해 주세요.');
  }
  return { id: raw.id, expectedVersion: raw.expectedVersion };
}

function parseDateChanges(raw: unknown, allowEmpty = false): ScheduleBulkDateChanges {
  if (!isRecord(raw) || (!allowEmpty && !Object.keys(raw).length)) {
    throw new SchedulePasteError(400, '변경할 날짜 항목을 하나 이상 선택해 주세요.');
  }
  const changes: ScheduleBulkDateChanges = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(dateFields, key)) throw new SchedulePasteError(400, '변경할 날짜 항목을 확인해 주세요.');
    const field = key as keyof ScheduleBulkDateChanges;
    if (value !== null && !isCalendarDate(value)) {
      throw new SchedulePasteError(400, `${dateFields[field]}은 YYYY-MM-DD 형식으로 입력해 주세요.`);
    }
    changes[field] = value;
  }
  return changes;
}

function parseTeamBlockerInput(raw: unknown): ScheduleTeamBlockerInput {
  const invalid = () => new SchedulePasteError(400, '차단 관계의 두 업무와 검토할 날짜를 확인해 주세요.');
  if (!isRecord(raw) || Object.keys(raw).some(key => key !== 'source' && key !== 'target' && key !== 'rescheduleSuccessors') ||
      (Object.hasOwn(raw, 'rescheduleSuccessors') && typeof raw.rescheduleSuccessors !== 'boolean')) throw invalid();
  const endpoint = (value: unknown): TeamBlockerPair['source'] => {
    if (!isRecord(value) || !isRelationId(value.id) || !isVersion(value.expectedVersion) ||
        Object.keys(value).some(key => key !== 'id' && key !== 'expectedVersion' && key !== 'dates')) throw invalid();
    const { id, expectedVersion } = value;
    if (!Object.hasOwn(value, 'dates')) return { id, expectedVersion };
    if (!isRecord(value.dates) || Object.keys(value.dates).some(key => key !== 'startDate' && key !== 'endDate')) throw invalid();
    return { id, expectedVersion, dates: parseDateChanges(value.dates, true) };
  };
  const source = endpoint(raw.source), target = endpoint(raw.target);
  if (source.id === target.id) throw invalid();
  return { source, target, ...(raw.rescheduleSuccessors === true ? { rescheduleSuccessors: true } : {}) };
}

function parseBulkDateInput(raw: unknown): ScheduleBulkDateInput {
  if (!isRecord(raw) || (raw.projectId !== null && !isId(raw.projectId)) ||
      Object.keys(raw).some(key => !['projectId', 'issues', 'changes', 'dates', 'workdayDuration', 'rescheduleSuccessors', 'includeTeamBlockers'].includes(key))) {
    throw new SchedulePasteError(400, '프로젝트와 일정 일괄 변경 항목을 확인해 주세요.');
  }
  const followUp = parsePasteFollowUpOptions(raw);
  if (!Array.isArray(raw.issues) || !raw.issues.length || raw.issues.length > MAX_SCHEDULE_BULK_DATE_ISSUES) {
    const scope = raw.projectId === null ? '' : '한 프로젝트에서 ';
    throw new SchedulePasteError(400, `${scope}업무를 1~${MAX_SCHEDULE_BULK_DATE_ISSUES}개 선택해 주세요.`);
  }
  const ids = new Set<string>();
  const issues = raw.issues.map((entry: unknown) => {
    const issue = parseScheduleIssue(entry);
    if (ids.has(issue.id)) throw new SchedulePasteError(400, '같은 업무를 두 번 선택할 수 없습니다.');
    ids.add(issue.id);
    return issue;
  });
  const dates = Object.hasOwn(raw, 'dates') ? parseSelectedDateEdits(raw.dates, issues,
    '일괄 편집에 선택한 업무의 날짜와 같은 업무 버전을 지정해 주세요.') : [];
  let workdayDuration: ScheduleBulkDateInput['workdayDuration'];
  if (Object.hasOwn(raw, 'workdayDuration')) {
    const input = raw.workdayDuration;
    if (!isRecord(input) || Object.keys(input).some(key => key !== 'endpoint' && key !== 'workingDays') ||
        (input.endpoint !== 'startDate' && input.endpoint !== 'endDate') || typeof input.workingDays !== 'number' ||
        !Number.isSafeInteger(input.workingDays) || input.workingDays < 1 || input.workingDays > MAX_WORKING_DURATION_DAYS) {
      throw new SchedulePasteError(400, '계산할 시작일 또는 종료일과 1~3,650 사이의 근무일 수를 지정해 주세요.');
    }
    workdayDuration = { endpoint: input.endpoint, workingDays: input.workingDays };
  }
  const changes = parseDateChanges(raw.changes, dates.length > 0 || Boolean(workdayDuration));
  if (workdayDuration && Object.hasOwn(changes, workdayDuration.endpoint)) {
    throw new SchedulePasteError(400, '근무일로 계산할 날짜의 공통 값을 지정하거나 삭제할 수 없습니다.');
  }
  return { projectId: raw.projectId, issues, changes, dates, ...(workdayDuration ? { workdayDuration } : {}), ...followUp };
}

function parsePasteFollowUpOptions(raw: Record<string, unknown>) {
  if ((Object.hasOwn(raw, 'rescheduleSuccessors') && typeof raw.rescheduleSuccessors !== 'boolean') ||
      (Object.hasOwn(raw, 'includeTeamBlockers') && typeof raw.includeTeamBlockers !== 'boolean') ||
      (raw.includeTeamBlockers === true && raw.rescheduleSuccessors !== true)) {
    throw new SchedulePasteError(400, '후행 일정 검토 여부를 확인해 주세요.');
  }
  return { rescheduleSuccessors: raw.rescheduleSuccessors === true, includeTeamBlockers: raw.includeTeamBlockers === true };
}

function parseSheetChoices(raw: unknown): ScheduleSheetChoices {
  if (raw === undefined) return {};
  if (!isRecord(raw) || Object.keys(raw).length > SCHEDULE_PASTE_MAX_ROWS * 5 ||
      Object.entries(raw).some(([id, choice]) => !/^[a-f0-9]{64}$/u.test(id) || (choice !== 'current' && choice !== 'input'))) {
    throw new SchedulePasteError(400, '비교에서 선택한 일정 값을 확인해 주세요.');
  }
  return raw as ScheduleSheetChoices;
}

function parseSelectedDateEdits(raw: unknown, selection: ScheduleBulkDateInput['issues'], errorMessage: string): ScheduleBulkLinkDateEdit[] {
  const invalid = () => new SchedulePasteError(400, errorMessage);
  if (!Array.isArray(raw) || raw.length > selection.length) throw invalid();
  const versions = new Map(selection.map(({ id, expectedVersion }) => [id, expectedVersion]));
  return raw.map((value: unknown) => {
    if (!isRecord(value) || Object.keys(value).length !== 2) throw invalid();
    const issue = parseScheduleIssue(value.issue);
    if (versions.get(issue.id) !== issue.expectedVersion) throw invalid();
    versions.delete(issue.id);
    return { issue, changes: parseDateChanges(value.changes) };
  });
}

function parseBulkLinkAction(raw: Record<string, unknown>): ScheduleBulkLinkAction {
  const operation = Object.hasOwn(raw, 'operation') ? raw.operation : 'add';
  const hasType = Object.hasOwn(raw, 'type'), hasLag = Object.hasOwn(raw, 'lagDays');
  if (operation === 'remove') {
    if (hasType || hasLag) throw new SchedulePasteError(400, '연결 해제에는 유형이나 근무일 간격을 지정할 수 없습니다.');
    return { operation };
  }
  if (operation !== 'add' && operation !== 'update') {
    throw new SchedulePasteError(400, '선후행 연결 작업을 확인해 주세요.');
  }
  const type = isDependencyType(raw.type) ? raw.type : undefined;
  const lagDays = isDependencyLag(raw.lagDays) ? raw.lagDays : undefined;
  if ((hasType && type === undefined) || (hasLag && lagDays === undefined)) {
    throw new SchedulePasteError(400, '업무 연결 유형과 -3650~3650 사이의 정수 근무일 간격을 확인해 주세요.');
  }
  if (operation === 'update') {
    if (!hasType && !hasLag) throw new SchedulePasteError(400, '바꿀 연결 유형 또는 근무일 간격을 선택해 주세요.');
    return { operation, type, lagDays };
  }
  if (type === undefined || lagDays === undefined) {
    throw new SchedulePasteError(400, '새 연결의 유형과 근무일 간격을 지정해 주세요.');
  }
  return { operation, type, lagDays };
}

function parseBulkLinkInput(raw: unknown): ScheduleBulkLinkInput | ScheduleBulkChainInput {
  const invalid = () => new SchedulePasteError(400, '프로젝트와 일괄 연결 방향을 확인해 주세요.');
  if (!isRecord(raw) || !isId(raw.projectId)) throw invalid();
  const commonFields = ['projectId', 'issues', 'operation', 'type', 'lagDays', 'dates', 'rescheduleSuccessors', 'includeTeamBlockers'];
  const chain = raw.mode === 'chain';
  const allowed = new Set([...commonFields, ...(chain ? ['mode'] : ['anchor', 'direction'])]);
  if (Object.keys(raw).some(key => !allowed.has(key))) throw invalid();
  const action = parseBulkLinkAction(raw);
  const followUp = parsePasteFollowUpOptions(raw);
  if (!Array.isArray(raw.issues) || raw.issues.length < 2 || raw.issues.length > MAX_SCHEDULE_BULK_LINK_ISSUES) {
    throw new SchedulePasteError(400, `한 프로젝트에서 업무를 2~${MAX_SCHEDULE_BULK_LINK_ISSUES}개 선택해 주세요.`);
  }
  const issues = raw.issues.map(parseScheduleIssue);
  const ids = new Set(issues.map(issue => issue.id));
  const selection = {
    projectId: raw.projectId, issues, ...action, ...followUp,
  };
  const hasDates = Object.hasOwn(raw, 'dates');
  const datePayload = (targets: ScheduleBulkLinkInput['issues']) => hasDates ? { dates: parseSelectedDateEdits(raw.dates, targets,
    '일괄 연결에 선택한 업무의 날짜와 같은 업무 버전을 지정해 주세요.') } : {};
  if (chain) {
    if (ids.size !== issues.length) throw new SchedulePasteError(400, '순서에 같은 업무를 두 번 지정할 수 없습니다.');
    return { ...selection, mode: 'chain', ...datePayload(issues) };
  }
  if (raw.direction !== 'predecessor' && raw.direction !== 'successor') throw invalid();
  const anchor = parseScheduleIssue(raw.anchor);
  if (ids.size !== issues.length || ids.has(anchor.id)) {
    throw new SchedulePasteError(400, '기준 업무와 선택 업무는 각각 한 번만 지정해 주세요.');
  }
  return { ...selection, anchor, direction: raw.direction, ...datePayload([anchor, ...issues]) };
}

function parseBlockerLinkInput(raw: unknown): { projectId: string | null; relations: ScopedBlockerReference[] } {
  const invalid = () => new SchedulePasteError(400, `프로젝트와 차단 관계를 1~${MAX_SCHEDULE_BLOCKER_LINKS}개 선택해 주세요.`);
  if (!isRecord(raw) || Object.keys(raw).length !== 2 || (raw.projectId !== null && !isRelationId(raw.projectId)) ||
      !Array.isArray(raw.relations) || !raw.relations.length || raw.relations.length > MAX_SCHEDULE_BLOCKER_LINKS) throw invalid();
  const { projectId } = raw;
  const relations = Array.from(raw.relations, (entry: unknown) => {
    if (!isRecord(entry) || Object.keys(entry).length !== (projectId === null ? 3 : 2) ||
        !isRelationId(entry.id) || !isVersion(entry.version)) throw invalid();
    const relationProjectId = projectId ?? entry.projectId;
    if (!isRelationId(relationProjectId)) throw invalid();
    return { id: entry.id, version: entry.version, projectId: relationProjectId };
  });
  if (new Set(relations.map(({ id }) => id)).size !== relations.length) throw invalid();
  return { projectId, relations };
}

function findPreviewIssue(issues: ReadonlyMap<string, Issue>, errors: SchedulePastePreview['errors'],
  { id, expectedVersion }: ScheduleRowEditInput['issue'], line: number | null = null): Issue | null {
  const issue = issues.get(id);
  if (!issue) {
    errors.push({ line, issueId: id, message: '선택한 업무가 삭제되었거나 현재 프로젝트에 없습니다. 업무를 다시 선택해 주세요.' });
  } else if (issue.version !== expectedVersion) {
    errors.push({ line, issueId: id, key: issue.key, message: '업무가 변경되었습니다. 최신 업무를 불러온 뒤 다시 미리 확인해 주세요.' });
  } else return issue;
  return null;
}

function parseManualPreviewInput(raw: unknown): ScheduleManualPreviewInput {
  const invalid = () => new SchedulePasteError(400, '일정을 변경할 업무와 날짜 또는 이동 일수를 확인해 주세요.');
  if (!isRecord(raw)) throw invalid();
  const hasFollowUp = Object.hasOwn(raw, 'rescheduleSuccessors');
  const hasTeamBlockers = Object.hasOwn(raw, 'includeTeamBlockers');
  if ((hasFollowUp && typeof raw.rescheduleSuccessors !== 'boolean') ||
      (hasTeamBlockers && typeof raw.includeTeamBlockers !== 'boolean') ||
      (raw.includeTeamBlockers === true && raw.rescheduleSuccessors !== true)) throw invalid();
  const followUp = { ...(raw.rescheduleSuccessors === true ? { rescheduleSuccessors: true } : {}),
    ...(raw.includeTeamBlockers === true ? { includeTeamBlockers: true } : {}) };
  if (Object.hasOwn(raw, 'changes')) {
    if (Object.keys(raw).some(key => !['changes', 'rescheduleSuccessors', 'includeTeamBlockers'].includes(key)) ||
        !Array.isArray(raw.changes) || !raw.changes.length || raw.changes.length > MAX_SCHEDULE_MANUAL_ISSUES) throw invalid();
    const changes = Array.from(raw.changes, (value: unknown) => {
      if (!isRecord(value) || Object.keys(value).length !== 4) throw invalid();
      const { id, expectedVersion, startDate, endDate } = value;
      if (!isId(id) || !isVersion(expectedVersion) || (startDate !== null && !isCalendarDate(startDate)) ||
          (endDate !== null && !isCalendarDate(endDate))) throw invalid();
      return { id, expectedVersion, startDate, endDate };
    });
    if (new Set(changes.map(change => change.id)).size !== changes.length) throw invalid();
    return { changes, ...followUp };
  }
  const { issueIds, days, workingDays } = raw;
  const hierarchyTarget = Object.hasOwn(raw, 'hierarchy');
  const targetField = hierarchyTarget ? 'hierarchy' : 'issueIds';
  if (Object.keys(raw).some(key => ![targetField, 'days', 'workingDays', 'expectedProjects', 'rescheduleSuccessors', 'includeTeamBlockers'].includes(key)) ||
      typeof days !== 'number' || !Number.isSafeInteger(days) ||
      Math.abs(days) > MAX_WORKING_DURATION_DAYS || typeof workingDays !== 'boolean') throw invalid();
  let selection: { hierarchy: ReturnType<typeof parseScheduleIssue> } | { issueIds: string[] };
  if (hierarchyTarget) selection = { hierarchy: parseScheduleIssue(raw.hierarchy) };
  else {
    if (!Array.isArray(issueIds) || !issueIds.length || issueIds.length > MAX_SCHEDULE_MANUAL_ISSUES ||
        !issueIds.every(isId) || new Set(issueIds).size !== issueIds.length) throw invalid();
    selection = { issueIds };
  }
  let expectedProjects: { id: string; projectId: string }[] | undefined;
  if (Object.hasOwn(raw, 'expectedProjects')) {
    const ids = new Set('hierarchy' in selection ? [selection.hierarchy.id] : selection.issueIds);
    if (!Array.isArray(raw.expectedProjects) || raw.expectedProjects.length !== ids.size) throw invalid();
    expectedProjects = Array.from(raw.expectedProjects, (value: unknown) => {
      if (!isRecord(value) || Object.keys(value).length !== 2 || !isId(value.id) || !isId(value.projectId) || !ids.delete(value.id)) throw invalid();
      return { id: value.id, projectId: value.projectId };
    });
  }
  return { ...selection, days, workingDays, ...followUp, ...(expectedProjects && { expectedProjects }) };
}

function parseRowDependencyEdit(raw: unknown): ScheduleRowDependencyEdit {
  const invalid = () => new SchedulePasteError(400, '업무 연결 변경 항목을 확인해 주세요.');
  if (!isRecord(raw)) throw invalid();
  const { action, id, expectedVersion, direction, type, lagDays, reverse } = raw;
  const relatedIssue = parseScheduleIssue(raw.relatedIssue);
  const common = ['action', 'relatedIssue'];
  const validKeys = (keys: string[]) => Object.keys(raw).every(key => keys.includes(key) || common.includes(key));
  if (action === 'remove') {
    if (!validKeys(['id', 'expectedVersion']) || !isId(id) || !isVersion(expectedVersion)) throw invalid();
    return { action, id, expectedVersion, relatedIssue };
  }
  if (!isDependencyType(type) || !isDependencyLag(lagDays)) {
    throw new SchedulePasteError(400, '업무 연결 유형과 -3650~3650 사이의 정수 근무일 간격을 확인해 주세요.');
  }
  if (action === 'add' && validKeys(['direction', 'type', 'lagDays']) && (direction === 'predecessor' || direction === 'successor')) {
    return { action, relatedIssue, direction, type, lagDays };
  }
  if (action === 'update' && validKeys(['id', 'expectedVersion', 'type', 'lagDays', 'reverse']) && isId(id) && isVersion(expectedVersion) &&
      (!Object.hasOwn(raw, 'reverse') || typeof reverse === 'boolean')) {
    return { action, id, expectedVersion, relatedIssue, type, lagDays, ...(reverse === true ? { reverse } : {}) };
  }
  throw invalid();
}

function parseRowEditInput(raw: unknown): Pick<ScheduleRowEditInput, 'projectId' | 'issue' | 'changes'> & {
  linkEdits: { line: number | null; input: ScheduleRowDependencyEdit }[];
  relatedDateEdits: ScheduleBulkLinkDateEdit[];
  rescheduleSuccessors: boolean;
  includeTeamBlockers: boolean;
  reviewIncomingTeamBlockers: boolean;
} {
  if (!isRecord(raw) || !isId(raw.projectId) ||
    Object.keys(raw).some(key => !['projectId', 'issue', 'changes', 'relatedDates', 'relatedDateEdits', 'dependency', 'dependencies', 'rescheduleSuccessors',
      'includeTeamBlockers', 'reviewIncomingTeamBlockers'].includes(key)) ||
    (Object.hasOwn(raw, 'rescheduleSuccessors') && typeof raw.rescheduleSuccessors !== 'boolean') ||
    (Object.hasOwn(raw, 'includeTeamBlockers') && typeof raw.includeTeamBlockers !== 'boolean') ||
    (raw.includeTeamBlockers === true && raw.rescheduleSuccessors !== true) ||
    (Object.hasOwn(raw, 'reviewIncomingTeamBlockers') && typeof raw.reviewIncomingTeamBlockers !== 'boolean') ||
    (Object.hasOwn(raw, 'dependency') && Object.hasOwn(raw, 'dependencies')) ||
    (Object.hasOwn(raw, 'relatedDates') && Object.hasOwn(raw, 'relatedDateEdits'))) {
    throw new SchedulePasteError(400, '프로젝트와 업무 일정 변경 항목을 확인해 주세요.');
  }
  let linkEdits: { line: number | null; input: ScheduleRowDependencyEdit }[] = [];
  if (Object.hasOwn(raw, 'dependencies')) {
    if (!Array.isArray(raw.dependencies) || raw.dependencies.length > MAX_SCHEDULE_ROW_DEPENDENCY_EDITS) {
      throw new SchedulePasteError(400, `업무 연결 변경은 배열로 최대 ${MAX_SCHEDULE_ROW_DEPENDENCY_EDITS}개까지 지정해 주세요.`);
    }
    linkEdits = raw.dependencies.map((value: unknown, index: number) => ({ line: index + 1, input: parseRowDependencyEdit(value) }));
  } else if (raw.dependency !== undefined) {
    linkEdits = [{ line: null, input: parseRowDependencyEdit(raw.dependency) }];
  }
  const relatedInputs = Object.hasOwn(raw, 'relatedDateEdits') ? raw.relatedDateEdits
    : Object.hasOwn(raw, 'relatedDates') ? [raw.relatedDates] : [];
  if (!Array.isArray(relatedInputs) || relatedInputs.length >= MAX_SCHEDULE_BULK_LINK_ISSUES) {
    throw new SchedulePasteError(400, `연결 업무의 날짜는 배열로 최대 ${MAX_SCHEDULE_BULK_LINK_ISSUES - 1}개까지 지정해 주세요.`);
  }
  const relatedDateEdits = relatedInputs.map((input: unknown): ScheduleBulkLinkDateEdit => {
    if (!isRecord(input) || Object.keys(input).length !== 2) {
      throw new SchedulePasteError(400, '연결 업무와 날짜 변경 항목을 확인해 주세요.');
    }
    return { issue: parseScheduleIssue(input.issue), changes: parseDateChanges(input.changes) };
  });
  return {
    projectId: raw.projectId,
    issue: parseScheduleIssue(raw.issue),
    changes: raw.changes === undefined ? {} : parseDateChanges(raw.changes, true),
    relatedDateEdits,
    linkEdits,
    rescheduleSuccessors: raw.rescheduleSuccessors === true,
    includeTeamBlockers: raw.includeTeamBlockers === true,
    reviewIncomingTeamBlockers: raw.reviewIncomingTeamBlockers === true,
  };
}

function proposeDateEdit(issue: Issue, requested: ScheduleBulkDateChanges): { change: ScheduleDateMutation; summary: ScheduleChange } | null {
  const startDate = requested.startDate === undefined ? issue.startDate : requested.startDate;
  const endDate = requested.endDate === undefined ? issue.endDate : requested.endDate;
  const fromDue = issue.dueDate ?? null;
  const toDue = requested.dueDate === undefined ? fromDue : requested.dueDate;
  if (startDate === issue.startDate && endDate === issue.endDate && toDue === fromDue) return null;
  return {
    change: { id: issue.id, expectedVersion: issue.version, startDate, endDate, ...(fromDue !== toDue ? { dueDate: toDue } : {}) },
    summary: { id: issue.id, key: issue.key, title: issue.title, version: issue.version,
      fromStart: issue.startDate, fromEnd: issue.endDate, fromDue, toStart: startDate, toEnd: endDate, toDue },
  };
}

function omitUnchangedDueDate(summary: ScheduleChange): ScheduleChange {
  const { fromDue, toDue, ...startAndEnd } = summary;
  return fromDue === toDue ? startAndEnd : summary;
}

function proposeRowDependencyEdit(input: ScheduleRowDependencyEdit, issue: Issue, related: Issue,
  byId: ReadonlyMap<string, Dependency>, byPair: ReadonlyMap<string, Dependency>):
{ pairs: readonly string[]; mutation: ScheduleDependencyMutation | null } | { error: string } {
  if (issue.id === related.id) return { error: '자기 자신에게 의존할 수 없습니다.' };
  if (input.action === 'add') {
    const [predecessorId, successorId] = input.direction === 'predecessor' ? [related.id, issue.id] : [issue.id, related.id];
    const pair = dependencyPair(predecessorId, successorId);
    if (byPair.has(pair)) {
      return { error: '이미 연결된 의존성입니다. 기존 업무 연결을 선택해 주세요.' };
    }
    const after = { id: randomUUID(), predecessorId, successorId, type: input.type, lagDays: input.lagDays };
    return { pairs: [pair], mutation: { before: null, after } };
  }
  const before = byId.get(input.id);
  if (!before || !((before.predecessorId === issue.id && before.successorId === related.id) ||
      (before.predecessorId === related.id && before.successorId === issue.id))) {
    return { error: '선택한 두 업무 사이의 연결을 찾을 수 없습니다. 연결을 다시 확인해 주세요.' };
  }
  if ((before.version ?? 1) !== input.expectedVersion) return { error: '업무 연결이 변경되었습니다. 최신 연결을 다시 확인해 주세요.' };
  const pair = dependencyPair(before.predecessorId, before.successorId);
  if (input.action === 'remove') return { pairs: [pair], mutation: { before, after: null } };
  if (!input.reverse && before.type === input.type && before.lagDays === input.lagDays) return { pairs: [pair], mutation: null };
  const after = { ...before, type: input.type, lagDays: input.lagDays };
  if (!input.reverse) return { pairs: [pair], mutation: { before, after } };
  const reversedPair = dependencyPair(before.successorId, before.predecessorId);
  if (byPair.has(reversedPair)) return { error: '이미 바꿀 방향으로 연결되어 있습니다. 기존 업무 연결을 확인해 주세요.' };
  after.predecessorId = before.successorId;
  after.successorId = before.predecessorId;
  return { pairs: [pair, reversedPair], mutation: { before, after } };
}

function incidentLinks(dependencies: Dependency[], issueIds: Iterable<string>) {
  const targets = new Set(issueIds);
  return dependencies.filter(link => targets.has(link.predecessorId) || targets.has(link.successorId));
}

function affectedLinks(dependencies: Dependency[], issueIds: Iterable<string>, linkChanges: ScheduleDependencyMutation[]) {
  const targets = new Set(issueIds);
  const linkIds = new Set(linkChanges.flatMap(change => change.after ? [change.after.id] : []));
  return dependencies.filter(link => linkIds.has(link.id) || targets.has(link.predecessorId) || targets.has(link.successorId));
}

function fixedScheduleDates(changes: ReadonlyMap<string, ScheduleDateMutation>, issues: ReadonlyMap<string, Issue>) {
  return [...changes.values()].filter(({ id, startDate, endDate }) => {
    const issue = issues.get(id)!;
    return startDate !== issue.startDate || endDate !== issue.endDate;
  });
}

function reviewScheduleFollowUps(preview: SchedulePastePreview, issues: ReadonlyMap<string, Issue>, projectedLinks: Dependency[],
  changes: Map<string, ScheduleDateMutation>, linkChanges: ScheduleDependencyMutation[], targetIds: Set<string>, hooks: PasteHooks,
  { includeUnchangedDueDates = false }: { includeUnchangedDueDates?: boolean } = {}) {
  const projectOf = (id: string) => issues.get(id)!.projectId;
  const fixedChanges = fixedScheduleDates(changes, issues);
  const fixedIds = new Set(fixedChanges.map(({ id }) => id));
  const anchors = Map.groupBy(fixedChanges, ({ id }) => projectOf(id));
  const successors = Map.groupBy(new Set(linkChanges.flatMap(({ after }) => after ? [after.successorId] : [])), projectOf);
  const projects = new Set([...anchors.keys(), ...successors.keys()]);
  if (!projects.size) return [];

  const issuesByProject = Map.groupBy(issues.values(), ({ projectId }) => projectId);
  const linksByProject = Map.groupBy(projectedLinks, ({ predecessorId }) => projectOf(predecessorId));
  const summaries = new Map(preview.changes.map(summary => [summary.id, summary]));
  const followUpIds: string[] = [], warnings: string[] = [];
  for (const projectId of projects) {
    let plan: ReturnType<typeof calculateFixedFollowUpSchedule>;
    try {
      plan = calculateFixedFollowUpSchedule({
        issues: issuesByProject.get(projectId)!, dependencies: linksByProject.get(projectId) ?? [],
        calendar: hooks.calendar(projectId), workflow: hooks.workflow(projectId),
        anchors: anchors.get(projectId) ?? [], successorIssueIds: successors.get(projectId),
      });
    } catch (error) {
      if (!(error instanceof AutomaticScheduleError)) throw error;
      preview.errors.push({ line: null, message: error.message });
      continue;
    }
    // Guard every reviewed successor, including unchanged tasks that could gain links or a different predecessor constraint.
    for (const id of plan.issueIds) targetIds.add(id);
    const newChangeCount = plan.changes.filter(({ id }) => !changes.has(id)).length;
    if (changes.size + newChangeCount > MAX_SCHEDULE_MANUAL_ISSUES) {
      preview.errors.push({ line: null, message: `한 번에 변경할 수 있는 업무는 ${MAX_SCHEDULE_MANUAL_ISSUES}개입니다. 범위를 나누어 미리 확인해 주세요.` });
      break;
    }
    for (const message of plan.blocking) preview.errors.push({ line: null, message });
    warnings.push(...plan.warnings);
    for (const { id, toStart, toEnd } of plan.changes) {
      if (fixedIds.has(id)) continue;
      const issue = issues.get(id)!;
      const edit = proposeDateEdit(issue, { startDate: toStart, endDate: toEnd, dueDate: changes.get(id)?.dueDate });
      if (!edit) continue;
      const error = hooks.validateChange(issue, edit.change);
      if (error) preview.errors.push({ line: null, issueId: id, key: issue.key, message: error });
      else {
        changes.set(id, edit.change);
        const summary = includeUnchangedDueDates ? edit.summary : omitUnchangedDueDate(edit.summary);
        summaries.set(id, preview.projectId === null ? { ...summary, projectId } : summary);
        followUpIds.push(id);
      }
    }
  }
  preview.changes = [...summaries.values()];
  if (followUpIds.length) preview.followUpIssueIds = followUpIds;
  for (const { id, startDate, endDate, dueDate } of changes.values()) {
    const issue = issues.get(id)!;
    if (startDate === issue.startDate && endDate === issue.endDate) continue;
    const deadline = dueDate === undefined ? issue.dueDate : dueDate;
    if (endDate && deadline && endDate > deadline) warnings.push(`${issue.key}: 제안한 종료일 ${endDate}이 목표 마감일 ${deadline}보다 늦습니다.`);
  }
  return warnings;
}

function mergeScheduleState(base: ScheduleState, extra: ScheduleState): ScheduleState {
  const issues = new Map([...base.issues, ...extra.issues].map(issue => [issue.id, issue]));
  const dependencies = new Map([...base.dependencies, ...extra.dependencies].map(link => [link.id, link]));
  return { issues: [...issues.values()], dependencies: [...dependencies.values()] };
}

function prepareBulkDependencyChanges(dependencies: Dependency[], pairs: DependencyCandidate[], action: ScheduleBulkLinkAction) {
  const dependencyChanges: SchedulePasteDependencyChange[] = [];
  const retainedDependencies: SchedulePasteDependencyChange[] = [];
  const missingDependencies: SchedulePasteDependencyPair[] = [];
  const linkChanges: ScheduleDependencyMutation[] = [];
  const errors: SchedulePastePreview['errors'] = [];
  const linksByPair = new Map(dependencies.map(link => [dependencyPair(link.predecessorId, link.successorId), link]));
  for (const { line, predecessor, successor, projectId } of pairs) {
    const summary = { line, predecessorKey: predecessor.key, predecessorTitle: predecessor.title,
      successorKey: successor.key, successorTitle: successor.title, ...(projectId ? { projectId } : {}) };
    const existing = linksByPair.get(dependencyPair(predecessor.id, successor.id));
    if (!existing) {
      if (action.operation === 'update' || action.operation === 'remove') {
        missingDependencies.push(summary);
        continue;
      }
      const settings = { type: action.type, lagDays: action.lagDays };
      linkChanges.push({ before: null, after: { id: randomUUID(), predecessorId: predecessor.id, successorId: successor.id, ...settings } });
      dependencyChanges.push({ ...summary, before: null, after: settings });
      continue;
    }
    const saved = { type: existing.type, lagDays: existing.lagDays };
    if (action.operation === 'remove') {
      linkChanges.push({ before: existing, after: null });
      dependencyChanges.push({ ...summary, before: saved, after: null });
      continue;
    }
    const settings = action.operation === 'update'
      ? { type: action.type ?? existing.type, lagDays: action.lagDays ?? existing.lagDays }
      : saved;
    if (settings.type === saved.type && settings.lagDays === saved.lagDays) {
      retainedDependencies.push({ ...summary, before: saved, after: saved });
      continue;
    }
    linkChanges.push({ before: existing, after: { ...existing, ...settings } });
    dependencyChanges.push({ ...summary, before: saved, after: settings });
  }

  const projectedLinks = linkChanges.length ? projectScheduleDependencies(dependencies, linkChanges) : dependencies;
  if (linkChanges.some(change => !change.before) && hasScheduleDependencyCycle(projectedLinks)) {
    errors.push({ line: null, message: '적용할 업무 연결에 순환 관계가 있습니다. 연결 방향을 확인해 주세요.' });
  }
  return { dependencyChanges, retainedDependencies, unchanged: retainedDependencies.length, errors, linkChanges, projectedLinks,
    ...(missingDependencies.length ? { missingDependencies } : {}) };
}

function reviewBulkLinkDates(issues: Issue[], related: Dependency[], calculateWarnings: PasteHooks['warnings'],
  dates?: ReadonlyMap<string, ScheduleDateMutation>) {
  const missingDateWarnings: string[] = [];
  let warnings: string[] = [];
  if (related.length) {
    const projectedIssues = dates?.size ? issues.map(issue => {
      const change = dates.get(issue.id);
      return change ? { ...issue, startDate: change.startDate, endDate: change.endDate } : issue;
    }) : issues;
    const byId = new Map(projectedIssues.map(issue => [issue.id, issue]));
    for (const link of related) {
      const predecessor = byId.get(link.predecessorId), successor = byId.get(link.successorId);
      if (!predecessor || !successor) continue;
      const endpoints = DEPENDENCY_ENDPOINTS[link.type];
      const missingDates: string[] = [];
      if (!predecessor[endpoints.predecessor]) missingDates.push(`${predecessor.key} ${SCHEDULE_DATE_LABELS[endpoints.predecessor]}`);
      if (!successor[endpoints.successor]) missingDates.push(`${successor.key} ${SCHEDULE_DATE_LABELS[endpoints.successor]}`);
      if (missingDates.length) missingDateWarnings.push(`${predecessor.key} → ${successor.key} · 날짜 미정 (${missingDates.join(', ')})`);
    }
    warnings = [...missingDateWarnings, ...calculateWarnings(projectedIssues, related)];
  }
  return { warnings, missingDateWarnings };
}

export class SchedulePasteService {
  constructor(private store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS schedule_paste_previews (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS schedule_paste_remove_after ON schedule_paste_previews(json_extract(json,'$.removeAfter'));
    `);
    this.prune();
  }

  private prune() {
    this.store.db.prepare("DELETE FROM schedule_paste_previews WHERE json_extract(json,'$.removeAfter') <= ?").run(after(0));
  }

  private projectState(projectId: string): ScheduleState {
    const issueRows = this.store.db.prepare('SELECT json FROM issues WHERE project_id=?').all(projectId) as {json: string}[];
    const dependencyRows = this.store.db.prepare(
      'SELECT d.json FROM dependencies d JOIN issues i ON d.predecessor_id=i.id WHERE i.project_id=? ORDER BY d.id',
    ).all(projectId) as {json: string}[];
    return {
      issues: issueRows.map(row => JSON.parse(row.json) as Issue),
      dependencies: dependencyRows.map(row => JSON.parse(row.json) as Dependency),
    };
  }

  private scopeState(scope: ScheduleScope): ScheduleState {
    if (scope.projectId !== null) return this.projectState(scope.projectId);
    const groups = (scope.projectIds ?? []).map(id => this.projectState(id));
    return { issues: groups.flatMap(group => group.issues), dependencies: groups.flatMap(group => group.dependencies) };
  }

  private teamFollowUpContext(anchors: ScheduleAnchorChange[], hooks: ScheduleReviewHooks,
    { applying = false, linkChanges = [], successorIds = [], proposedBlocker }: {
      applying?: boolean; linkChanges?: ScheduleDependencyMutation[]; successorIds?: string[]; proposedBlocker?: TeamBlockerPair;
    } = {}) {
    const error = (status: number, message: string) => new SchedulePasteError(applying ? 409 : status, message);
    const limit = () => error(422, '프로젝트 간 후행 일정은 전체 업무 10,000개와 연결 50,000개 이하에서 검토할 수 있습니다.');
    const issueRows = this.store.db.prepare('SELECT json FROM issues ORDER BY id LIMIT ?')
      .all(MAX_WORKLOAD_LEVEL_ISSUES + 1) as { json: string }[];
    const linkRows = this.store.db.prepare('SELECT json FROM dependencies ORDER BY id LIMIT ?')
      .all(MAX_WORKLOAD_LEVEL_DEPENDENCIES + 1) as { json: string }[];
    if (issueRows.length > MAX_WORKLOAD_LEVEL_ISSUES || linkRows.length > MAX_WORKLOAD_LEVEL_DEPENDENCIES) throw limit();
    const issues = issueRows.map(({ json }) => JSON.parse(json) as Issue);
    const localLinks = linkRows.map(({ json }) => JSON.parse(json) as Dependency);
    const projectedLinks = linkChanges.length ? projectScheduleDependencies(localLinks, linkChanges) : localLinks;
    if (projectedLinks.length > MAX_WORKLOAD_LEVEL_DEPENDENCIES) throw limit();
    const issueMap = new Map(issues.map(issue => [issue.id, issue]));
    const terminalByIssue = new Map<string, boolean>();
    const terminal = (issue: Issue) => {
      let closed = terminalByIssue.get(issue.id);
      if (closed === undefined) terminalByIssue.set(issue.id, closed = hooks.isTerminal(issue));
      return closed;
    };
    const blockers: Dependency[] = [];
    for (const relation of hooks.teamBlockers([...issueMap.keys()])) {
      const { id, sourceIssueId, targetIssueId, version, origin } = relation;
      const source = issueMap.get(sourceIssueId), target = issueMap.get(targetIssueId);
      if (!source || !target || source.projectId === target.projectId || terminal(source) || terminal(target)) continue;
      blockers.push({ id: `team-blocker:${origin ?? 'teamspace'}:${id}`, predecessorId: sourceIssueId, successorId: targetIssueId,
        ...TEAM_BLOCKER_SCHEDULE_RULE, version });
      if (projectedLinks.length + blockers.length > MAX_WORKLOAD_LEVEL_DEPENDENCIES) throw limit();
    }
    if (proposedBlocker) {
      const predecessorId = proposedBlocker.source.id, successorId = proposedBlocker.target.id;
      blockers.push({ id: `proposed-team-blocker:${JSON.stringify([predecessorId, successorId])}`, predecessorId, successorId,
        ...TEAM_BLOCKER_SCHEDULE_RULE });
      if (projectedLinks.length + blockers.length > MAX_WORKLOAD_LEVEL_DEPENDENCIES) throw limit();
    }
    let graph: ReturnType<typeof teamBatchFollowUpScope>;
    try { graph = teamBatchFollowUpScope(anchors, issues, [...projectedLinks, ...blockers], successorIds); }
    catch (cause) {
      if (!(cause instanceof TeamFollowUpScheduleError)) throw cause;
      throw error(cause.status, cause.message);
    }
    const projectIds = [...new Set(graph.issues.map(issue => issue.projectId))].sort();
    const guard = createHash('sha256').update(JSON.stringify({
      selectedIds: [...graph.selectedIds].sort(),
      issues: graph.issues.map(issue => [issue.id, issue.version, issue.projectId, issue.startDate, issue.endDate, issue.dueDate, issue.status]),
      dependencies: graph.dependencies.map(dependencyGuardFields).sort(([a], [b]) => a.localeCompare(b)),
      projects: projectIds.map(id => [id, hooks.versions(id)]),
    })).digest('hex');
    const linkIds = new Set(graph.dependencies.map(link => link.id));
    return { graph, terminal, guard, state: { issues: graph.issues, dependencies: localLinks.filter(link => linkIds.has(link.id)) } };
  }

  private reviewTeamScheduleFollowUps(preview: TeamFollowUpReview, issues: ReadonlyMap<string, Issue>,
    changes: Map<string, ScheduleDateMutation>, linkChanges: ScheduleDependencyMutation[], hooks: PasteHooks,
    { includeUnchangedDueDates = false, proposedBlocker, fixedDates = fixedScheduleDates(changes, issues) }: {
      includeUnchangedDueDates?: boolean; proposedBlocker?: TeamBlockerPair; fixedDates?: readonly ScheduleAnchorChange[];
    } = {}) {
    const anchors = fixedDates.map(({ id, expectedVersion, startDate, endDate }) =>
      ({ id, expectedVersion, startDate, endDate }));
    const successorIds = [...new Set(linkChanges.flatMap(({ after }) => after ? [after.successorId] : []))];
    if (proposedBlocker) successorIds.push(proposedBlocker.target.id);
    if (!anchors.length && !successorIds.length) return null;

    let context: ReturnType<SchedulePasteService['teamFollowUpContext']>;
    try { context = this.teamFollowUpContext(anchors, hooks, { linkChanges, successorIds, proposedBlocker }); }
    catch (error) {
      if (!(error instanceof SchedulePasteError) || error.status !== 422) throw error;
      preview.errors.push({ line: null, message: error.message });
      return null;
    }
    const calendars = new Map<string, ReturnType<typeof createCalendarMath>>();
    const projectedIssues = context.graph.issues.map(issue => {
      const dueDate = changes.get(issue.id)?.dueDate;
      return dueDate === undefined ? issue : { ...issue, dueDate };
    });
    const plan = calculateTeamFollowUpSchedule({ ...context.graph, issues: projectedIssues }, projectId => {
      let math = calendars.get(projectId);
      if (!math) calendars.set(projectId, math = createCalendarMath(hooks.calendar(projectId)));
      return math;
    }, context.terminal);
    for (const message of plan.blocking) preview.errors.push({ line: null, message });
    if (changes.size + plan.changes.filter(({ id }) => !changes.has(id)).length > MAX_SCHEDULE_MANUAL_ISSUES) {
      preview.errors.push({ line: null, message: `한 번에 변경할 수 있는 업무는 ${MAX_SCHEDULE_MANUAL_ISSUES}개입니다. 범위를 나누어 미리 확인해 주세요.` });
      return null;
    }
    const summaries = new Map(preview.changes.map(change => [change.id, change]));
    const byId = new Map(context.graph.issues.map(issue => [issue.id, issue]));
    const followUpIds: string[] = [];
    for (const { id, toStart, toEnd } of plan.changes) {
      if (context.graph.fixedDates.has(id)) continue;
      const issue = byId.get(id)!;
      const edit = proposeDateEdit(issue, { startDate: toStart, endDate: toEnd, dueDate: changes.get(id)?.dueDate });
      if (!edit) continue;
      const message = hooks.validateChange(issue, edit.change);
      if (message) preview.errors.push({ line: null, issueId: id, key: issue.key, message });
      else {
        changes.set(id, edit.change);
        const summary = includeUnchangedDueDates ? edit.summary : omitUnchangedDueDate(edit.summary);
        summaries.set(id, { ...summary, projectId: issue.projectId });
        followUpIds.push(id);
      }
    }
    preview.changes = [...summaries.values()];
    if (followUpIds.length) preview.followUpIssueIds = followUpIds;
    return { state: context.state, warnings: plan.warnings,
      proposal: { anchors, ...(successorIds.length ? { successorIds } : {}), guard: context.guard } };
  }

  private issueScheduleState(issue: Issue): ScheduleState {
    const linkRows = this.store.db.prepare('SELECT json FROM dependencies WHERE predecessor_id=? OR successor_id=? ORDER BY id')
      .all(issue.id, issue.id) as { json: string }[];
    const dependencies = linkRows.map(({ json }) => JSON.parse(json) as Dependency);
    const relatedIds = new Set(dependencies.flatMap(({ predecessorId, successorId }) => [predecessorId, successorId]));
    relatedIds.delete(issue.id);
    const rows = this.store.db.prepare('SELECT json FROM issues WHERE id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify([...relatedIds])) as { json: string }[];
    return { issues: [issue, ...rows.map(({ json }) => JSON.parse(json) as Issue)], dependencies };
  }

  private incomingTeamBlockers(target: Issue, hooks: PasteHooks): IncomingTeamBlocker[] {
    if (hooks.isTerminal(target)) return [];
    return hooks.directBlockers(target.id).flatMap(relation => {
      const source = this.store.get<Issue>('issues', relation.sourceIssueId);
      return source && source.projectId !== target.projectId && !hooks.isTerminal(source) ? [{ relation, source }] : [];
    }).sort((left, right) => left.relation.id.localeCompare(right.relation.id));
  }

  reviewTeamBlockerDates(knownIssues: readonly Issue[], edits: readonly ScheduleDateMutation[],
    hooks: Pick<ScheduleReviewHooks, 'calendar' | 'teamBlockers' | 'isTerminal'>,
    { kind, teamBlocker: proposed, issueSaveStatus }: Pick<ProposalDraft, 'kind' | 'teamBlocker' | 'issueSaveStatus'> = {}) {
    if (!edits.length && !proposed) return null;
    const issues = new Map(knownIssues.map(issue => [issue.id, issue]));
    const changes = new Map(edits.map(edit => [edit.id, edit]));
    const incomingTargets = new Set<string>(), outgoingSources = new Set<string>();
    const projectedStatus = (issue: Issue) => issue.id === edits[0]?.id && kind === 'issue-save' && issueSaveStatus !== undefined
      ? { ...issue, status: issueSaveStatus } : issue;
    for (const edit of edits) {
      const issue = issues.get(edit.id);
      if (!issue) continue;
      const endChanged = edit.endDate !== issue.endDate;
      const reopened = kind === 'issue-save' && issueSaveStatus !== issue.status && hooks.isTerminal(issue) && !hooks.isTerminal(projectedStatus(issue));
      if (reopened || edit.startDate !== issue.startDate || (kind === 'bulk-links' && endChanged)) incomingTargets.add(edit.id);
      if (reopened || endChanged) outgoingSources.add(edit.id);
    }
    const endpoints = new Set(proposed ? [proposed.source.id, proposed.target.id] : []);
    const issueIds = [...new Set([...incomingTargets, ...outgoingSources, ...endpoints])];
    if (!issueIds.length) return null;

    const activeIssues = new Map<string, Issue | undefined>();
    const activeIssue = (id: string) => {
      if (!activeIssues.has(id)) {
        const issue = issues.get(id) ?? this.store.get<Issue>('issues', id);
        activeIssues.set(id, issue && !hooks.isTerminal(projectedStatus(issue)) ? issue : undefined);
      }
      return activeIssues.get(id);
    };
    const calendars = new Map<string, { version: number; math: ReturnType<typeof createCalendarMath> }>();
    const evidence = [];
    const warnings: string[] = [];
    function review(source: Issue, target: Issue) {
      let calendar = calendars.get(target.projectId);
      if (!calendar) {
        const workCalendar = hooks.calendar(target.projectId);
        calendar = { version: workCalendar.version, math: createCalendarMath(workCalendar) };
        calendars.set(target.projectId, calendar);
      }
      const check = checkDependencySchedule(TEAM_BLOCKER_SCHEDULE_RULE, changes.get(source.id) ?? source,
        changes.get(target.id) ?? target, calendar.math);
      const label = `프로젝트 간 차단 관계 ${source.key} → ${target.key}`;
      if (check.kind === 'missing') warnings.push(missingTeamBlockerDates(source, target, check));
      else if (check.kind === 'conflict') warnings.push(`${label} · 선행 업무 종료일 ${check.predecessorDate}에 따라 후행 업무 시작일은 ${check.requiredDate} 이후여야 합니다.`);
      else if (check.kind === 'invalid') warnings.push(`${label} · ${check.reason}`);
      return calendar.version;
    }
    for (const relation of hooks.teamBlockers(issueIds).sort((a, b) => a.id.localeCompare(b.id))) {
      const { id, version, origin, sourceIssueId, targetIssueId } = relation;
      if (proposed && sourceIssueId === proposed.source.id && targetIssueId === proposed.target.id) {
        throw new SchedulePasteError(409, '이미 같은 방향의 프로젝트 간 차단 관계가 있습니다.');
      }
      if (!outgoingSources.has(sourceIssueId) && !incomingTargets.has(targetIssueId) && !endpoints.has(sourceIssueId) && !endpoints.has(targetIssueId)) continue;
      const source = activeIssue(sourceIssueId), target = activeIssue(targetIssueId);
      if (!source || !target) continue;
      const calendarVersion = review(source, target);
      evidence.push([id, version, origin ?? 'teamspace', sourceIssueId, source.projectId, source.version, source.endDate,
        targetIssueId, target.projectId, target.version, target.startDate, calendarVersion]);
    }
    if (proposed) review(activeIssue(proposed.source.id)!, activeIssue(proposed.target.id)!);
    // An empty review still fences new or newly active relations before apply.
    return { guard: createHash('sha256').update(JSON.stringify(evidence)).digest('hex'), relationCount: evidence.length, warnings };
  }

  private scopeForIssues(issueIds: string[]): ScheduleScope {
    const rows = this.store.db.prepare(`SELECT DISTINCT project_id AS id FROM issues
      WHERE id IN (SELECT value FROM json_each(?)) ORDER BY project_id`).all(JSON.stringify(issueIds)) as { id: string }[];
    return { projectId: null, projectIds: rows.map(({ id }) => id) };
  }

  private workspaceKeys(keys: ReadonlySet<string>): Map<string, ScheduleKeyBinding | null> {
    const matches = new Map<string, ScheduleKeyBinding | null>();
    if (!keys.size) return matches;
    // Compare with the parser's case folding, including legacy keys outside ASCII.
    const rows = this.store.db.prepare("SELECT id, project_id AS projectId, json_extract(json, '$.key') AS key FROM issues")
      .iterate() as Iterable<ScheduleKeyBinding>;
    for (const issue of rows) {
      if (typeof issue.key !== 'string') continue;
      const key = issue.key.toUpperCase();
      if (keys.has(key)) matches.set(key, matches.has(key) ? null : { ...issue, key });
    }
    return matches;
  }

  private resolvePasteKeys(projectId: string | null, keys: ReadonlySet<string>): Map<string, ResolvedScheduleKeyBinding | null> {
    const resolved = new Map<string, ResolvedScheduleKeyBinding | null>();
    if (!keys.size) return resolved;
    const sql = "SELECT id, project_id AS projectId, json_extract(json, '$.key') AS key FROM issues";
    const rows = (projectId === null ? this.store.db.prepare(sql).all()
      : this.store.db.prepare(`${sql} WHERE project_id=?`).all(projectId)) as ScheduleKeyBinding[];
    const owners = rows.filter(owner => typeof owner.key === 'string');
    const aliases = readIssueSearchAliases(this.store, owners);
    const current = new Map<string, ScheduleKeyBinding | null>();
    const historical = new Map<string, Map<string, ResolvedScheduleKeyBinding>>();
    for (const owner of owners) {
      const inputKey = owner.key.toUpperCase();
      if (keys.has(inputKey)) current.set(inputKey, current.has(inputKey) ? null : owner);
      for (const alias of Object.hasOwn(aliases, owner.id) ? aliases[owner.id] : []) {
        const aliasKey = alias.key.trim().toUpperCase();
        if (!keys.has(aliasKey)) continue;
        let matches = historical.get(aliasKey);
        if (!matches) {
          matches = new Map();
          historical.set(aliasKey, matches);
        }
        // Two sources on the same issue still describe one candidate. Prefer the Jira label for both sources.
        if (!matches.has(owner.id) || alias.source === 'jira') matches.set(owner.id, { ...owner, inputKey: aliasKey, source: alias.source });
      }
    }
    for (const inputKey of keys) {
      const owner = current.get(inputKey);
      const matches = historical.get(inputKey);
      if (owner) {
        resolved.set(inputKey, { ...owner, inputKey, source: 'current',
          ...(matches && [...matches.keys()].some(id => id !== owner.id) ? { currentKeyConflict: true } : {}) });
      } else if (owner === null || (matches && matches.size > 1)) resolved.set(inputKey, null);
      else if (matches) resolved.set(inputKey, [...matches.values()][0]);
    }
    return resolved;
  }

  private guard(scope: ScheduleScope & Pick<PasteProposal, 'kind' | 'hierarchyId'>, { issues, dependencies }: ScheduleState, targetIds: string[], hooks: ScheduleReviewHooks) {
    const links = incidentLinks(dependencies, targetIds);
    const related = new Set([...targetIds, ...links.flatMap(link => [link.predecessorId, link.successorId])]);
    // Keep the original single-project guard encoding for existing pending previews.
    const issueVersions = issues.filter(issue => related.has(issue.id)).sort((a, b) => a.id.localeCompare(b.id))
      .map(issue => {
        if (scope.kind === 'manual-edit' || scope.kind === 'team-blocker-edit') return [issue.id, issue.version, issue.projectId, issue.startDate, issue.endDate,
          ...(scope.hierarchyId ? [issue.parentId ?? null, issue.status] : [])];
        if (scope.kind === 'issue-save') return [issue.id, issue.version, issue.projectId, issue.startDate, issue.endDate, issue.dueDate, issue.status];
        if (scope.kind === 'blocker-links') return [issue.id, issue.version, issue.startDate, issue.endDate,
          ...(scope.projectId === null ? [issue.projectId] : [])];
        return scope.projectId === null ? [issue.id, issue.version, issue.projectId] : [issue.id, issue.version];
      });
    const linkVersions = links.map(dependencyGuardFields);
    const versions = scope.projectId === null
      ? (scope.projectIds ?? []).map(id => [id, hooks.versions(id)])
      : hooks.versions(scope.projectId);
    return createHash('sha256').update(JSON.stringify({issueVersions, linkVersions, versions})).digest('hex');
  }

  private savePreview(preview: SchedulePastePreview, state: ScheduleState,
    proposal: ProposalDraft, hooks: PasteHooks, teamIssues = state.issues): SchedulePastePreview {
    if (preview.errors.length || (!proposal.changes.length && !proposal.linkChanges?.length)) return preview;
    return { ...preview, ...this.saveProposal(preview, state, proposal, hooks, preview.warnings, teamIssues) };
  }

  private saveProposal(scope: ScheduleScope, state: ScheduleState, proposal: ProposalDraft, hooks: ScheduleReviewHooks, warnings: string[],
    teamIssues = state.issues) {
    const id = randomUUID();
    const expiresAt = after(AUTO_PREVIEW_TTL_MS);
    const team = this.reviewTeamBlockerDates(teamIssues, proposal.changes, hooks, proposal);
    const reviewedWarnings = [...new Set([...warnings, ...(team?.warnings ?? [])])];
    const savedWarnings = proposal.teamBlocker ? reviewedWarnings : team?.warnings;
    this.store.put(table, {
      ...proposal, id, projectId: scope.projectId, removeAfter: expiresAt,
      ...(scope.projectIds ? { projectIds: scope.projectIds } : {}),
      ...(team ? { teamBlockerGuard: team.guard } : {}),
      ...(savedWarnings?.length ? { teamBlockerWarnings: savedWarnings } : {}),
      guard: this.guard({ ...scope, kind: proposal.kind, hierarchyId: proposal.hierarchyId }, state, proposal.issueIds, hooks),
    } satisfies PasteProposal);
    return { previewId: id, expiresAt, ...(team?.warnings.length ? {
      teamBlockerWarnings: team.warnings, warnings: reviewedWarnings,
    } : {}) };
  }

  previewIssueSave(issueId: string, raw: unknown, actorId: string, hooks: ScheduleReviewHooks,
    defaultDueDate: (before: Issue, after: Issue) => string | null): SchedulePreview {
    if (!isRecord(raw) || !isVersion(raw.expectedVersion) || !dateKeys.every(key => Object.hasOwn(raw, key)) ||
        Object.keys(raw).some(key => key !== 'expectedVersion' && key !== 'status' && !Object.hasOwn(dateFields, key)) ||
        (Object.hasOwn(raw, 'status') && !isId(raw.status))) {
      throw new SchedulePasteError(400, '확인한 업무 버전과 시작일, 종료일, 목표 마감일을 보내 주세요.');
    }
    const { expectedVersion, status, ...dates } = raw;
    const requested = parseDateChanges(dates);
    return this.store.transaction(() => {
      const before = this.store.get<Issue>('issues', issueId);
      if (!before) throw new SchedulePasteError(404, '업무를 찾을 수 없습니다.');
      if (before.version !== expectedVersion) {
        throw new SchedulePasteError(409, '다른 작업자가 변경했습니다. 새로고침 후 다시 시도해 주세요.', { currentVersion: before.version });
      }
      const preview: SchedulePreview = { changes: [], warnings: [] };
      if (requested.startDate && requested.endDate && requested.startDate > requested.endDate) {
        return { ...preview, blocking: ['종료일은 시작일보다 빠를 수 없습니다.'] };
      }
      const proposed = { ...before, ...requested, status: typeof status === 'string' ? status : before.status, updatedAt: after(0) };
      const dueDate = defaultDueDate(before, proposed) ?? proposed.dueDate;
      const edit = proposeDateEdit(before, { ...requested, dueDate });
      if (!edit) return preview;
      this.prune();
      const state = this.issueScheduleState(before);
      const warnings = hooks.warnings([{ ...proposed, dueDate }, ...state.issues.slice(1)], state.dependencies);
      return { changes: [omitUnchangedDueDate(edit.summary)], warnings,
        ...this.saveProposal({ projectId: before.projectId }, state, {
          actorId, issueIds: [before.id], changes: [edit.change], kind: 'issue-save', issueSaveStatus: proposed.status,
        }, hooks, warnings) };
    });
  }

  /** The ordinary issue update owns this transaction and commits all of the prepared fields together. */
  consumeIssueSavePreview(previewId: unknown, actorId: string, before: Issue, proposed: Issue, hooks: ScheduleReviewHooks): void {
    if (typeof previewId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(previewId)) {
      throw new SchedulePasteError(400, '확인한 업무 일정 미리보기 ID를 보내 주세요.');
    }
    const stale = () => new SchedulePasteError(409, '확인한 일정이나 관련 업무가 변경되었거나 확인이 만료되었습니다. 일정을 다시 검토해 주세요.',
      { reason: 'schedule_preview_stale' });
    const proposal = this.store.get<PasteProposal>(table, previewId);
    if (!proposal || proposal.kind !== 'issue-save' || proposal.actorId !== actorId || proposal.projectId !== before.projectId ||
        proposal.removeAfter <= after(0) || proposal.issueSaveStatus !== proposed.status) throw stale();
    const [change] = proposal.changes;
    if (!change || change.id !== before.id || change.expectedVersion !== before.version || change.startDate !== proposed.startDate ||
        change.endDate !== proposed.endDate || (Object.hasOwn(change, 'dueDate') ? change.dueDate : before.dueDate ?? null) !== proposed.dueDate) throw stale();
    const state = this.issueScheduleState(before);
    if (this.guard(proposal, state, proposal.issueIds, hooks) !== proposal.guard ||
        this.reviewTeamBlockerDates(state.issues, proposal.changes, hooks, proposal)?.guard !== proposal.teamBlockerGuard) throw stale();
    this.store.remove(table, previewId);
  }

  private previewManual(raw: unknown, actorId: string, hooks: PasteHooks): SchedulePreview {
    const input = parseManualPreviewInput(raw);
    const shift = 'changes' in input ? null : input;
    const hierarchy = 'hierarchy' in input ? input.hierarchy : null;
    const expectedProjects = new Map(shift?.expectedProjects?.map(({ id, projectId }) => [id, projectId]));
    const checkProject = (issue: Issue) => {
      const expected = expectedProjects.get(issue.id);
      if (expected !== undefined && expected !== issue.projectId) {
        throw new SchedulePasteError(409, `${issue.key}: 선택한 업무가 다른 프로젝트로 이동했습니다. 미리보기를 닫고 현재 프로젝트에서 다시 선택해 주세요.`,
          { reason: 'project_changed' });
      }
    };
    const shiftTarget = (id: string) => ({ id, expectedVersion: undefined, startDate: null, endDate: null });
    return this.store.transaction(() => {
      this.prune();
      const anchor = hierarchy ? this.store.get<Issue>('issues', hierarchy.id) : null;
      if (hierarchy && !anchor) throw new SchedulePasteError(404, '상위 업무가 삭제되었거나 존재하지 않습니다. 업무를 다시 선택해 주세요.');
      if (anchor) checkProject(anchor);
      let selected = 'changes' in input ? input.changes : 'issueIds' in input ? input.issueIds.map(shiftTarget) : [];
      const scope = anchor ? { projectId: anchor.projectId } : this.scopeForIssues(selected.map(({ id }) => id));
      const state = this.scopeState(scope);
      const categories = anchor ? new Map(hooks.workflow(anchor.projectId).statuses.map(status => [status.id, status.category])) : null;
      if (hierarchy && anchor) {
        if (anchor.version !== hierarchy.expectedVersion) {
          throw new SchedulePasteError(409, `${anchor.key}: 업무가 변경되었습니다. 최신 업무를 불러온 뒤 다시 미리 확인해 주세요.`);
        }
        const trace = traceGanttHierarchy(anchor.id, state.issues, issue => categories?.get(issue.status) ?? 'backlog');
        if (!trace) throw new SchedulePasteError(404, '상위 업무가 삭제되었거나 존재하지 않습니다. 업무를 다시 선택해 주세요.');
        if (trace.issues.length > MAX_SCHEDULE_MANUAL_ISSUES) {
          throw new SchedulePasteError(400, `한 번에 검토할 수 있는 상위·하위 업무는 ${MAX_SCHEDULE_MANUAL_ISSUES}개입니다. 하위 업무를 기준으로 범위를 나누어 주세요.`);
        }
        selected = trace.issues.map(issue => shiftTarget(issue.id));
      }
      const byId = new Map(state.issues.map(issue => [issue.id, issue]));
      const calendars = new Map<string, ReturnType<typeof createCalendarMath>>();
      const changes = new Map<string, ScheduleDateMutation>();
      const skipped: SchedulePreview['skipped'] = hierarchy ? [] : undefined;
      const preview: SchedulePreview = { changes: [], warnings: [], ...(skipped ? { skipped } : {}) };
      const blocking: string[] = [];
      const addDateChange = (issue: Issue, dates: Pick<Issue, 'startDate' | 'endDate'>) => {
        const edit = proposeDateEdit(issue, dates);
        if (!edit) return;
        const error = hooks.validateChange(issue, edit.change);
        if (error) blocking.push(`${issue.key}: ${error}`);
        else {
          changes.set(issue.id, edit.change);
          const summary = omitUnchangedDueDate(edit.summary);
          preview.changes.push(input.includeTeamBlockers ? { ...summary, projectId: issue.projectId } : summary);
        }
      };
      for (const { id, expectedVersion, startDate, endDate } of selected) {
        const issue = byId.get(id);
        if (!issue) throw new SchedulePasteError(404, '선택한 업무가 삭제되었거나 존재하지 않습니다. 업무를 다시 선택해 주세요.');
        if (!hierarchy) checkProject(issue);
        if (expectedVersion !== undefined && issue.version !== expectedVersion) {
          throw new SchedulePasteError(409, `${issue.key}: 업무가 변경되었습니다. 최신 업무를 불러온 뒤 다시 미리 확인해 주세요.`);
        }
        let dates = { startDate, endDate };
        if (shift) {
          const category = categories?.get(issue.status);
          const reason = category === 'done' || category === 'cancelled' ? 'closed' : !issue.startDate && !issue.endDate ? 'unscheduled' : null;
          if (reason) {
            if (skipped) skipped.push({ id, key: issue.key, title: issue.title, reason });
            else preview.warnings.push(`${issue.key}: 일정이 없어 이동하지 않습니다.`);
            continue;
          }
          let math = calendars.get(issue.projectId);
          if (shift.workingDays && !math) {
            math = createCalendarMath(hooks.calendar(issue.projectId));
            calendars.set(issue.projectId, math);
          }
          const move = (date: string | null) => {
            if (date === null) return null;
            return math ? math.shift(date, shift.days) : calendarDate(calendarDay(date) + shift.days);
          };
          try { dates = { startDate: move(issue.startDate), endDate: move(issue.endDate) }; }
          catch (error) {
            if (!(error instanceof CalendarError)) throw error;
            blocking.push(`${issue.key}: ${error.message}`);
            continue;
          }
        }
        addDateChange(issue, dates);
      }
      const selectedIds = selected.map(({ id }) => id);
      const issueIds = new Set(selectedIds);
      const followUpWarnings: string[] = [];
      let teamFollowUp: PasteProposal['teamFollowUp'];
      let reviewState = state;
      if (input.rescheduleSuccessors && !blocking.length && ('changes' in input || changes.size)) {
        const followUp = 'changes' in input ? input.changes : [...changes.values()];
        const followUpIssueIds: string[] = [];
        function collectFollowUp(plan: Pick<SchedulePreview, 'changes' | 'warnings'> & { blocking: string[] },
          anchors: ScheduleAnchorChange[], issues: ReadonlyMap<string, Issue>) {
          blocking.push(...plan.blocking);
          followUpWarnings.push(...plan.warnings);
          const anchorIds = new Set(anchors.map(({ id }) => id));
          for (const { id, toStart, toEnd } of plan.changes) {
            if (anchorIds.has(id)) continue;
            addDateChange(issues.get(id)!, { startDate: toStart, endDate: toEnd });
            if (changes.has(id)) followUpIssueIds.push(id);
          }
        }
        if (input.includeTeamBlockers) {
          let context: ReturnType<SchedulePasteService['teamFollowUpContext']>;
          try { context = this.teamFollowUpContext(followUp, hooks); }
          catch (cause) {
            if (!(cause instanceof SchedulePasteError) || cause.status !== 422) throw cause;
            return { ...preview, blocking: [cause.message] };
          }
          teamFollowUp = { anchors: followUp, guard: context.guard };
          reviewState = context.state;
          const plan = calculateTeamFollowUpSchedule(context.graph, projectId => {
            let math = calendars.get(projectId);
            if (!math) calendars.set(projectId, math = createCalendarMath(hooks.calendar(projectId)));
            return math;
          }, context.terminal);
          collectFollowUp(plan, followUp, new Map(reviewState.issues.map(issue => [issue.id, issue])));
        } else {
          const anchorsByProject = Map.groupBy(followUp, ({ id }) => byId.get(id)!.projectId);
          const issuesByProject = Map.groupBy(state.issues, ({ projectId }) => projectId);
          const dependenciesByProject = Map.groupBy(state.dependencies, ({ predecessorId }) => byId.get(predecessorId)!.projectId);
          for (const [projectId, anchors] of anchorsByProject) {
            const plan = calculateFixedFollowUpSchedule({
              issues: issuesByProject.get(projectId)!, dependencies: dependenciesByProject.get(projectId) ?? [],
              calendar: hooks.calendar(projectId), workflow: hooks.workflow(projectId), anchors,
            });
            // An unchanged successor can gain a dependency before this proposal is applied.
            for (const id of plan.issueIds) issueIds.add(id);
            collectFollowUp(plan, anchors, byId);
          }
          for (const { id, key, toEnd } of preview.changes) {
            const dueDate = byId.get(id)?.dueDate;
            if (toEnd && dueDate && toEnd > dueDate) followUpWarnings.push(`${key}: 제안한 종료일 ${toEnd}이 목표 마감일 ${dueDate}보다 늦습니다.`);
          }
        }
        if (followUpIssueIds.length) preview.followUpIssueIds = followUpIssueIds;
        if (changes.size > MAX_SCHEDULE_MANUAL_ISSUES) {
          blocking.push(`한 번에 변경할 수 있는 업무는 ${MAX_SCHEDULE_MANUAL_ISSUES}개입니다. 범위를 나누어 미리 확인해 주세요.`);
        }
      }
      if (changes.size) {
        const projected = reviewState.issues.map(issue => {
          const change = changes.get(issue.id);
          return change ? { ...issue, startDate: change.startDate, endDate: change.endDate } : issue;
        });
        preview.warnings.push(...hooks.warnings(projected, incidentLinks(reviewState.dependencies, changes.keys())));
      }
      if (followUpWarnings.length) preview.warnings = [...new Set([...followUpWarnings, ...preview.warnings])];
      if (blocking.length) return { ...preview, blocking: [...new Set(blocking)] };
      if (!changes.size) return preview;
      return { ...preview, ...this.saveProposal(scope, state, {
        actorId, issueIds: [...issueIds], changes: [...changes.values()], kind: 'manual-edit',
        ...(hierarchy ? { hierarchyId: hierarchy.id, hierarchyIssueIds: selectedIds } : {}),
        ...(teamFollowUp ? { teamFollowUp } : {}),
        ...(followUpWarnings.length ? { followUpWarnings } : {}),
      }, hooks, preview.warnings, reviewState.issues) };
    });
  }

  private preview(projectId: unknown, raw: unknown, choices: ScheduleSheetChoices, actorId: string, hooks: PasteHooks,
    { rescheduleSuccessors, includeTeamBlockers }: ReturnType<typeof parsePasteFollowUpOptions>): SchedulePastePreview {
    if (projectId !== null && (typeof projectId !== 'string' || !projectId || projectId.length > 200)) {
      throw new SchedulePasteError(400, '붙여넣을 프로젝트를 선택해 주세요.');
    }
    const parsed = parseSchedulePaste(raw);
    return this.store.transaction(() => {
      if (projectId !== null && !this.store.get('projects', projectId)) throw new SchedulePasteError(404, '프로젝트를 찾을 수 없습니다.');
      this.prune();
      const keys = this.resolvePasteKeys(projectId, new Set(parsed.rows.flatMap(({ key, dependency }) => dependency ? [key, dependency.predecessorKey] : [key])));
      const projectIds = projectId === null ? [...new Set([...keys.values()].flatMap(binding => binding ? [binding.projectId] : []))].sort() : undefined;
      const scope = { projectId, ...(projectIds ? { projectIds } : {}) };
      const state = this.scopeState(scope);
      const {issues, dependencies} = state;
      const byId = new Map(issues.map(issue => [issue.id, issue]));
      const byKey = new Map<string, Issue | null>();
      const keyMappings: SchedulePasteKeyMapping[] = [];
      for (const [key, binding] of keys) {
        const issue = binding ? byId.get(binding.id) : undefined;
        byKey.set(key, issue ?? null);
        if (!issue || !binding || (binding.source === 'current' && !binding.currentKeyConflict)) continue;
        keyMappings.push({ inputKey: key, issueId: issue.id, key: issue.key, title: issue.title, projectId: issue.projectId,
          source: binding.source, ...(binding.currentKeyConflict ? { currentKeyConflict: true } : {}) });
      }
      const scopeLabel = projectId === null ? '전체 프로젝트에' : '이 프로젝트에';
      const dependencyChanges: SchedulePasteDependencyChange[] = [];
      const retainedDependencies: SchedulePasteDependencyChange[] = [];
      const unchangedRows: string[] = [];
      const preview: SchedulePastePreview = {
        ...scope, previewId:null, expiresAt:null, changes:[], dependencyChanges, warnings:[], errors:parsed.errors, unchanged:0,
        ...(keyMappings.length ? { keyMappings } : {}),
      };
      const sheet = scheduleSheetCellReviewer(preview, choices);
      const changes = new Map<string, ScheduleDateMutation>();
      const linkChanges: ScheduleDependencyMutation[] = [];
      const byPair = new Map(dependencies.map(link => [dependencyPair(link.predecessorId, link.successorId), link]));
      const targetIds = new Set<string>();
      const resolvedRows: { row: SchedulePasteRow; issue: Issue; datesChanged: boolean }[] = [];
      const requestedDates = new Map<string, { issue: Issue; line: number | null; dates: ScheduleBulkDateChanges;
        firstLines: Partial<Record<typeof dateKeys[number], number>> }>();
      const invalidDates = new Set<string>();
      for (const row of parsed.rows) {
        const issue = byKey.get(row.key);
        if (!issue) {
          const message = issue === null ? `${scopeLabel} 동일한 업무 키가 두 개 이상 있습니다.` : `${scopeLabel} 해당 업무 키가 없습니다.`;
          preview.errors.push({line:row.line,key:row.key,message});
          continue;
        }
        const baseline = row.baseline;
        if (baseline && baseline.issueId !== issue.id) {
          preview.errors.push({ line: row.line, key: row.key, message: '업무 키와 내려받은 일정표의 업무가 다릅니다. 현재 업무 키를 확인해 주세요.' });
          continue;
        }
        const request = requestedDates.get(issue.id) ?? { issue, line: null, dates: {}, firstLines: {} };
        const mergeCell = sheet.forRow(row.line, row.key, [issue.projectId, issue.id]);
        let datesChanged = false;
        for (const field of dateKeys) {
          let value = row[field];
          if (value === undefined) continue;
          const current = issue[field] ?? null;
          if (baseline) {
            const original = baseline[field] ?? null;
            if (value === original) continue;
            value = mergeCell(field, dateFields[field], original, current, value);
            if (value === undefined) continue;
          }
          datesChanged ||= value !== current;
          const firstLine = request.firstLines[field];
          if (firstLine === undefined) {
            request.dates[field] = value;
            request.firstLines[field] = row.line;
          } else if (request.dates[field] !== value) {
            invalidDates.add(issue.id);
            preview.errors.push({ line: row.line, key: row.key,
              message: `${issue.key}의 ${dateFields[field]} 값이 ${firstLine}번째 줄의 값과 충돌합니다.` });
          }
        }
        if (datesChanged && request.line === null) request.line = row.line;
        if (Object.keys(request.dates).length) requestedDates.set(issue.id, request);
        resolvedRows.push({ row, issue, datesChanged });
      }

      for (const { issue, line, dates } of requestedDates.values()) {
        if (invalidDates.has(issue.id)) continue;
        const edit = proposeDateEdit(issue, dates);
        if (!edit) continue;
        const { change, summary } = edit;
        const { startDate, endDate } = change;
        let error: string | null;
        if (startDate && endDate && startDate > endDate) {
          error = '종료일을 시작일 이후로 지정해 주세요.';
        } else {
          error = hooks.validateChange(issue, change);
        }
        if (error) {
          invalidDates.add(issue.id);
          preview.errors.push({line,key:issue.key.toUpperCase(),message:error});
          continue;
        }
        changes.set(issue.id, change);
        preview.changes.push(omitUnchangedDueDate(projectId === null || includeTeamBlockers ? { ...summary, projectId: issue.projectId } : summary));
      }

      const seenRows = new Map<string, number>();
      for (const { row, issue, datesChanged } of resolvedRows) {
        if (invalidDates.has(issue.id)) continue;
        targetIds.add(issue.id);
        const input = row.dependency;
        let predecessor: Issue | undefined;
        if (input) {
          const baseline = row.baseline?.dependency;
          const untouched = baseline && unchangedScheduleSheetLink(input, baseline);
          const matched = untouched ? byId.get(baseline.predecessorId) : byKey.get(input.predecessorKey);
          if (untouched && matched?.projectId !== issue.projectId) {
            if (!datesChanged) unchangedRows.push(issue.id);
            continue;
          }
          if (!matched || matched.id === issue.id) {
            const message = matched === null ? `선행 업무 키 ${input.predecessorKey}가 ${scopeLabel} 중복되어 있습니다.`
              : matched ? '자기 자신에게 의존할 수 없습니다.' : `${scopeLabel} 선행 업무 키 ${input.predecessorKey}가 없습니다.`;
            preview.errors.push({line:row.line,key:row.key,message});
            continue;
          }
          if (matched.projectId !== issue.projectId) {
            preview.errors.push({ line: row.line, key: row.key, message: `선행 업무 ${matched.key}는 같은 프로젝트에 있어야 합니다.` });
            continue;
          }
          predecessor = matched;
        }
        const pair = dependencyPair(predecessor?.id ?? '', issue.id);
        const firstLine = seenRows.get(pair);
        if (firstLine !== undefined) {
          const subject = predecessor ? `${predecessor.key} → ${issue.key} 선행 업무 연결` : `${issue.key}의 날짜 전용 행`;
          preview.errors.push({ line: row.line, key: row.key, message: `${subject}이 ${firstLine}번째 줄과 중복되었습니다.` });
          continue;
        }
        seenRows.set(pair, row.line);
        if (input && predecessor) {
          targetIds.add(predecessor.id);
          const before = byPair.get(pair);
          const merge = mergeScheduleSheetLink(input, predecessor.id, before, row.baseline?.dependency,
            sheet.forRow(row.line, row.key, [issue.projectId, issue.id, predecessor.id, before?.id ?? '']));
          if (!merge) continue;
          if ('errors' in merge) {
            for (const message of merge.errors) preview.errors.push({ line: row.line, key: row.key, message });
            continue;
          }
          const after = !merge.values ? null : {
            id:before?.id ?? randomUUID(),predecessorId:predecessor.id,successorId:issue.id,
            ...merge.values,
          } as const satisfies Dependency;
          const changed = after ? !before || before.type !== after.type || before.lagDays !== after.lagDays : Boolean(before);
          const summary: SchedulePasteDependencyChange = {
            line: row.line, predecessorKey: predecessor.key, predecessorTitle: predecessor.title, successorKey: issue.key, successorTitle: issue.title,
            before: before ? { type: before.type, lagDays: before.lagDays } : null,
            after: after ? { type: after.type, lagDays: after.lagDays } : null,
            ...(projectId === null ? { projectId: issue.projectId } : {}),
          };
          if (changed) {
            if (before) linkChanges.push({before,after});
            else if (after) linkChanges.push({before:null,after});
            dependencyChanges.push(summary);
            continue;
          }
          if (before && after) retainedDependencies.push(summary);
        }
        if (!datesChanged) unchangedRows.push(issue.id);
      }
      sheet.verifyChoices();
      if (retainedDependencies.length) preview.retainedDependencies = retainedDependencies;
      const projectedLinks = linkChanges.length ? projectScheduleDependencies(dependencies, linkChanges) : dependencies;
      if (linkChanges.some(change => !change.before) && hasScheduleDependencyCycle(projectedLinks)) {
        preview.errors.push({line:null,message:'적용할 선행 업무 연결에 순환 관계가 있습니다. 연결 방향을 확인해 주세요.'});
      }
      const teamFollowUp = includeTeamBlockers && !preview.errors.length
        ? this.reviewTeamScheduleFollowUps(preview, byId, changes, linkChanges, hooks) : null;
      const followUpWarnings = teamFollowUp?.warnings ?? (rescheduleSuccessors && !includeTeamBlockers && !preview.errors.length
        ? reviewScheduleFollowUps(preview, byId, projectedLinks, changes, linkChanges, targetIds, hooks) : []);
      const reviewState = teamFollowUp ? mergeScheduleState(state, teamFollowUp.state) : state;
      const reviewedLinks = teamFollowUp ? projectScheduleDependencies(reviewState.dependencies, linkChanges) : projectedLinks;
      const adjustedIssues = new Set(preview.followUpIssueIds);
      preview.unchanged = unchangedRows.filter(id => !adjustedIssues.has(id)).length;
      preview.errors.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
      if (changes.size || linkChanges.length) {
        const projected = reviewState.issues.map(issue => {
          const change = changes.get(issue.id);
          return change ? {
            ...issue, startDate: change.startDate, endDate: change.endDate,
            dueDate: change.dueDate === undefined ? issue.dueDate : change.dueDate,
          } : issue;
        });
        const warnings = hooks.warnings(projected, affectedLinks(reviewedLinks, changes.keys(), linkChanges));
        preview.warnings = followUpWarnings.length ? [...new Set([...followUpWarnings, ...warnings])] : warnings;
      }
      const resolvedKeyBindings = [...keys.values()].filter((binding): binding is ResolvedScheduleKeyBinding => Boolean(binding && targetIds.has(binding.id)));
      return this.savePreview(preview, state, {
        actorId, issueIds: [...targetIds], changes: [...changes.values()], linkChanges, resolvedKeyBindings,
        ...(teamFollowUp ? { teamFollowUp: teamFollowUp.proposal } : {}),
        ...(followUpWarnings.length ? { followUpWarnings } : {}),
      }, hooks, reviewState.issues);
    });
  }

  private previewBulkDates(raw: unknown, actorId: string, hooks: PasteHooks): SchedulePastePreview {
    const { projectId, issues: selected, changes: sharedDates, dates = [], workdayDuration, rescheduleSuccessors, includeTeamBlockers } = parseBulkDateInput(raw);
    return this.store.transaction(() => {
      if (projectId !== null && !this.store.get('projects', projectId)) throw new SchedulePasteError(404, '프로젝트를 찾을 수 없습니다.');
      this.prune();
      const selectedIds = selected.map(({ id }) => id);
      const scope: ScheduleScope = projectId === null ? this.scopeForIssues(selectedIds) : { projectId };
      const state = this.scopeState(scope);
      const byId = new Map(state.issues.map(issue => [issue.id, issue]));
      const rowDates = new Map(dates.map(({ issue, changes }) => [issue.id, changes]));
      const preview: SchedulePastePreview = {
        ...scope, previewId: null, expiresAt: null, changes: [], warnings: [], errors: [], unchanged: 0,
      };
      const changes = new Map<string, ScheduleDateMutation>();
      const unchanged = new Set<string>();
      const calendars = new Map<string, ReturnType<typeof createCalendarMath>>();
      for (const { id, expectedVersion } of selected) {
        const issue = byId.get(id);
        if (!issue) {
          const message = projectId === null ? '선택한 업무가 삭제되었거나 존재하지 않습니다. 업무를 다시 선택해 주세요.'
            : '선택한 업무가 삭제되었거나 현재 프로젝트에 없습니다. 업무를 다시 선택해 주세요.';
          preview.errors.push({ line: null, issueId: id, message });
          continue;
        }
        if (issue.version !== expectedVersion) {
          preview.errors.push({ line: null, issueId: id, key: issue.key, message: '업무가 변경되었습니다. 최신 업무를 불러온 뒤 다시 미리 확인해 주세요.' });
          continue;
        }
        const requested = { ...sharedDates, ...rowDates.get(id) };
        if (workdayDuration && !Object.hasOwn(requested, workdayDuration.endpoint)) {
          const { endpoint, workingDays } = workdayDuration;
          const anchor = endpoint === 'endDate' ? 'startDate' : 'endDate';
          const date = requested[anchor] === undefined ? issue[anchor] : requested[anchor];
          if (!date) {
            preview.errors.push({ line: null, issueId: id, key: issue.key, message: `근무일로 계산하려면 기준 ${dateFields[anchor]}을 입력해 주세요.` });
            continue;
          }
          try {
            let math = calendars.get(issue.projectId);
            if (!math) calendars.set(issue.projectId, math = createCalendarMath(hooks.calendar(issue.projectId)));
            requested[endpoint] = calculateWorkingDateRange(math, anchor, date, workingDays)[endpoint];
          } catch (cause) {
            if (!(cause instanceof CalendarError)) throw cause;
            preview.errors.push({ line: null, issueId: id, key: issue.key, message: cause.message });
            continue;
          }
        }
        const edit = proposeDateEdit(issue, requested);
        if (!edit) {
          unchanged.add(id);
          continue;
        }
        const error = hooks.validateChange(issue, edit.change);
        if (error) {
          preview.errors.push({ line: null, issueId: id, key: issue.key, message: error });
          continue;
        }
        changes.set(id, edit.change);
        preview.changes.push(includeTeamBlockers ? { ...edit.summary, projectId: issue.projectId } : edit.summary);
      }
      const targetIds = new Set(selectedIds);
      const teamFollowUp = includeTeamBlockers && !preview.errors.length
        ? this.reviewTeamScheduleFollowUps(preview, byId, changes, [], hooks, { includeUnchangedDueDates: true }) : null;
      const followUpWarnings = teamFollowUp?.warnings ?? (rescheduleSuccessors && !includeTeamBlockers && !preview.errors.length
        ? reviewScheduleFollowUps(preview, byId, state.dependencies, changes, [], targetIds, hooks, { includeUnchangedDueDates: true }) : []);
      const reviewState = teamFollowUp ? mergeScheduleState(state, teamFollowUp.state) : state;
      for (const id of preview.followUpIssueIds ?? []) unchanged.delete(id);
      preview.unchanged = unchanged.size;
      if (changes.size) {
        const projected = reviewState.issues.map(issue => {
          const change = changes.get(issue.id);
          return change ? { ...issue, startDate: change.startDate, endDate: change.endDate,
            dueDate: change.dueDate === undefined ? issue.dueDate : change.dueDate } : issue;
        });
        const warnings = hooks.warnings(projected, affectedLinks(reviewState.dependencies, changes.keys(), []));
        preview.warnings = followUpWarnings.length ? [...new Set([...followUpWarnings, ...warnings])] : warnings;
      }
      return this.savePreview(preview, state, {
        actorId, issueIds: [...targetIds], changes: [...changes.values()], kind: 'bulk-dates',
        ...(teamFollowUp ? { teamFollowUp: teamFollowUp.proposal } : {}),
        ...(followUpWarnings.length ? { followUpWarnings } : {}),
      }, hooks, reviewState.issues);
    });
  }

  private previewRowEdit(raw: unknown, actorId: string, hooks: PasteHooks): SchedulePastePreview {
    const { projectId, issue: selected, changes: requested, relatedDateEdits, linkEdits,
      rescheduleSuccessors, includeTeamBlockers, reviewIncomingTeamBlockers } = parseRowEditInput(raw);
    return this.store.transaction(() => {
      if (!this.store.get('projects', projectId)) throw new SchedulePasteError(404, '프로젝트를 찾을 수 없습니다.');
      this.prune();
      const state = this.projectState(projectId);
      const issuesById = new Map(state.issues.map(issue => [issue.id, issue]));
      const dependencyChanges: SchedulePasteDependencyChange[] = [];
      const preview: SchedulePastePreview = {
        projectId, previewId: null, expiresAt: null, changes: [], dependencyChanges, warnings: [], errors: [], unchanged: 0,
      };
      const issue = findPreviewIssue(issuesById, preview.errors, selected);
      if (!issue) return preview;
      const explicitRows = new Map([[issue.id, { issue, changes: requested }]]);
      for (const edit of relatedDateEdits) {
        const related = findPreviewIssue(issuesById, preview.errors, edit.issue);
        if (!related) continue;
        if (explicitRows.has(related.id)) {
          preview.errors.push({ line: null, issueId: related.id, key: related.key, message: '같은 업무의 날짜를 두 번 변경할 수 없습니다.' });
        } else explicitRows.set(related.id, { issue: related, changes: edit.changes });
      }
      if (preview.errors.length) return preview;
      const issueIds = new Set(explicitRows.keys());
      const changes = new Map<string, ScheduleDateMutation>();
      const missingDateWarnings: string[] = [];
      const teamBlockerGuards: [string, string][] = [];
      const recordDates = (target: Issue, request: ScheduleBulkDateChanges) => {
        const dates = proposeDateEdit(target, request);
        if (!dates) return;
        const error = hooks.validateChange(target, dates.change);
        if (error) preview.errors.push({ line: null, issueId: target.id, key: target.key, message: error });
        else {
          changes.set(target.id, dates.change);
          preview.changes.push(includeTeamBlockers ? { ...dates.summary, projectId: target.projectId } : dates.summary);
        }
      };
      const explicitIssues = [...explicitRows.values()].map(row => row.issue);
      const linkOnly = !Object.keys(requested).length && !relatedDateEdits.length;
      for (const row of explicitRows.values()) recordDates(row.issue, row.changes);
      for (const target of explicitIssues) {
        const targetDates = changes.get(target.id);
        if (!reviewIncomingTeamBlockers || !targetDates || (targetDates.startDate === target.startDate && targetDates.endDate === target.endDate)) continue;
        const blockers = this.incomingTeamBlockers(target, hooks);
        teamBlockerGuards.push([target.id, incomingTeamBlockerGuard(blockers)]);
        if (blockers.length) {
          const math = createCalendarMath(hooks.calendar(projectId));
          for (const { source } of blockers) {
            const check = checkDependencySchedule(TEAM_BLOCKER_SCHEDULE_RULE, source, targetDates, math);
            if (check.kind === 'missing') {
              missingDateWarnings.push(missingTeamBlockerDates(source, target, check));
            } else if (check.kind === 'conflict' || check.kind === 'invalid') {
              const message = check.kind === 'conflict'
                ? `프로젝트 간 선행 업무 ${source.key}의 종료일 ${check.predecessorDate}에 따라 시작일은 ${check.requiredDate} 이후여야 합니다.`
                : `프로젝트 간 선행 업무 ${source.key} · ${check.reason}`;
              preview.errors.push({ line: null, issueId: target.id, key: target.key, message });
            }
          }
        }
      }

      const linkChanges: ScheduleDependencyMutation[] = [];
      const seenLinks = new Set<string>(), seenPairs = new Set<string>();
      const linksById = new Map(state.dependencies.map(link => [link.id, link]));
      const linksByPair = new Map(state.dependencies.map(link => [dependencyPair(link.predecessorId, link.successorId), link]));
      const linkError = (line: number | null, message: string) => preview.errors.push({ line, issueId: issue.id, key: issue.key, message });
      const duplicate = '같은 방향의 업무 연결을 두 번 변경할 수 없습니다.';
      for (const { line, input } of linkEdits) {
        const related = findPreviewIssue(issuesById, preview.errors, input.relatedIssue, line);
        if (!related) continue;
        issueIds.add(related.id);
        if (input.action !== 'add') {
          if (seenLinks.has(input.id)) { linkError(line, duplicate); continue; }
          seenLinks.add(input.id);
        }
        const proposal = proposeRowDependencyEdit(input, issue, related, linksById, linksByPair);
        if ('error' in proposal) { linkError(line, proposal.error); continue; }
        if (proposal.pairs.some(pair => seenPairs.has(pair))) { linkError(line, duplicate); continue; }
        for (const pair of proposal.pairs) seenPairs.add(pair);
        if (!proposal.mutation) continue;
        const { before, after } = proposal.mutation;
        const endpoints = after ?? before!;
        const [predecessor, successor] = endpoints.predecessorId === issue.id ? [issue, related] : [related, issue];
        linkChanges.push(proposal.mutation);
        dependencyChanges.push({
          line: line ?? 1, predecessorKey: predecessor.key, predecessorTitle: predecessor.title, successorKey: successor.key, successorTitle: successor.title,
          before: before && { type: before.type, lagDays: before.lagDays }, after: after && { type: after.type, lagDays: after.lagDays },
          ...(before && addsScheduleDependencyPair(proposal.mutation) ? {
            beforeDirection: { predecessorKey: successor.key, successorKey: predecessor.key },
          } : {}),
        });
      }
      const projectedLinks = linkChanges.length ? projectScheduleDependencies(state.dependencies, linkChanges) : state.dependencies;
      if (relatedDateEdits.length) {
        const neighbors = new Set(projectedLinks.flatMap(link => link.predecessorId === issue.id ? [link.successorId]
          : link.successorId === issue.id ? [link.predecessorId] : []));
        for (const related of explicitIssues.slice(1)) {
          if (!neighbors.has(related.id)) preview.errors.push({ line: null, issueId: related.id, key: related.key,
            message: '날짜를 함께 편집할 업무와의 선후행 연결을 확인해 주세요.' });
        }
      }
      if (!changes.size && !linkChanges.length && !preview.errors.length) preview.unchanged = 1;
      const followUpWarnings: string[] = [];
      let teamFollowUp: ReturnType<SchedulePasteService['reviewTeamScheduleFollowUps']> = null;
      let reviewState = state;
      if (changes.size || linkChanges.length) {
        if (linkChanges.some(addsScheduleDependencyPair) && hasScheduleDependencyCycle(projectedLinks)) {
          linkError(null, '적용할 업무 연결에 순환 관계가 있습니다. 연결 방향을 확인해 주세요.');
        }
        if (includeTeamBlockers && !preview.errors.length) {
          const fixedDates = [...explicitRows.values()].flatMap(row => {
            if (!Object.hasOwn(row.changes, 'startDate') && !Object.hasOwn(row.changes, 'endDate')) return [];
            const { startDate, endDate } = changes.get(row.issue.id) ?? row.issue;
            return [{ id: row.issue.id, expectedVersion: row.issue.version, startDate, endDate }];
          });
          teamFollowUp = this.reviewTeamScheduleFollowUps(preview, issuesById, changes, linkChanges, hooks, { includeUnchangedDueDates: true, fixedDates });
          if (teamFollowUp) {
            reviewState = mergeScheduleState(state, teamFollowUp.state);
            followUpWarnings.push(...teamFollowUp.warnings);
          }
        } else if (rescheduleSuccessors && !preview.errors.length && linkOnly) {
          followUpWarnings.push(...reviewScheduleFollowUps(preview, issuesById, projectedLinks, changes, linkChanges, issueIds, hooks,
            { includeUnchangedDueDates: true }));
        } else if (rescheduleSuccessors && !preview.errors.length) {
          const plan = calculateFixedFollowUpSchedule({
            issues: state.issues, dependencies: projectedLinks, calendar: hooks.calendar(projectId), workflow: hooks.workflow(projectId),
            anchors: explicitIssues.map(target => changes.get(target.id) ?? {
              id: target.id, expectedVersion: target.version, startDate: target.startDate, endDate: target.endDate,
            }),
          });
          // Include unchanged successors so a new link or changed outside predecessor also invalidates this review.
          for (const id of plan.issueIds) issueIds.add(id);
          for (const message of plan.blocking) preview.errors.push({ line: null, message });
          followUpWarnings.push(...plan.warnings);
          for (const suggestion of plan.changes) {
            if (explicitRows.has(suggestion.id)) continue; // Keep each explicit row's optional due-date edit.
            const successor = issuesById.get(suggestion.id)!;
            recordDates(successor, { startDate: suggestion.toStart, endDate: suggestion.toEnd });
          }
          if (changes.size > MAX_SCHEDULE_MANUAL_ISSUES && !preview.errors.length) {
            linkError(null, `한 번에 변경할 수 있는 업무는 ${MAX_SCHEDULE_MANUAL_ISSUES}개입니다. 범위를 나누어 미리 확인해 주세요.`);
          }
          for (const { key, toEnd, toDue } of preview.changes) {
            if (toEnd && toDue && toEnd > toDue) followUpWarnings.push(`${key}: 제안한 종료일 ${toEnd}이 목표 마감일 ${toDue}보다 늦습니다.`);
          }
        }
        const reviewedLinks = teamFollowUp ? projectScheduleDependencies(reviewState.dependencies, linkChanges) : projectedLinks;
        const affected = affectedLinks(reviewedLinks, changes.keys(), linkChanges);
        let warnings: string[];
        if (linkOnly) {
          const review = reviewBulkLinkDates(reviewState.issues, affected, hooks.warnings, changes);
          warnings = review.warnings;
          missingDateWarnings.push(...review.missingDateWarnings);
        } else {
          const projectedIssues = reviewState.issues.map(value => {
            const change = changes.get(value.id);
            return change ? { ...value, startDate: change.startDate, endDate: change.endDate } : value;
          });
          warnings = hooks.warnings(projectedIssues, affected);
        }
        preview.warnings = [...new Set([...followUpWarnings, ...missingDateWarnings, ...warnings])];
      }
      return this.savePreview(preview, state, { actorId, issueIds: [...issueIds], changes: [...changes.values()], linkChanges, kind: 'row-edit',
        ...(teamFollowUp ? { teamFollowUp: teamFollowUp.proposal } : {}),
        ...(followUpWarnings.length ? { followUpWarnings } : {}),
        ...(missingDateWarnings.length ? { missingDateWarnings } : {}),
        ...(teamBlockerGuards.length ? { incomingTeamBlockerGuard: teamBlockerGuards } : {}),
      }, hooks, reviewState.issues);
    });
  }

  private previewBulkLinks(raw: unknown, actorId: string, hooks: PasteHooks): SchedulePastePreview {
    const input = parseBulkLinkInput(raw);
    const { projectId, issues: selected, dates = [], rescheduleSuccessors, includeTeamBlockers } = input;
    return this.store.transaction(() => {
      if (!this.store.get('projects', projectId)) throw new SchedulePasteError(404, '프로젝트를 찾을 수 없습니다.');
      this.prune();
      const state = this.projectState(projectId);
      const issuesById = new Map(state.issues.map(issue => [issue.id, issue]));
      const preview: SchedulePastePreview = {
        projectId, previewId: null, expiresAt: null, changes: [], dependencyChanges: [], retainedDependencies: [], warnings: [], errors: [], unchanged: 0,
      };
      const pairs: DependencyCandidate[] = [];
      const issueIds = new Set('mode' in input ? [] : [input.anchor.id]);
      for (const { id } of selected) issueIds.add(id);
      if ('mode' in input) {
        const ordered = selected.map((entry, index) => findPreviewIssue(issuesById, preview.errors, entry, index + 1));
        for (let index = 1; index < ordered.length; index++) {
          const predecessor = ordered[index - 1];
          const successor = ordered[index];
          if (predecessor && successor) pairs.push({ line: index, predecessor, successor });
        }
      } else {
        const anchor = findPreviewIssue(issuesById, preview.errors, input.anchor);
        if (!anchor) return preview;
        for (const [index, entry] of selected.entries()) {
          const line = index + 1;
          const issue = findPreviewIssue(issuesById, preview.errors, entry, line);
          if (!issue) continue;
          const [predecessor, successor] = input.direction === 'predecessor' ? [anchor, issue] : [issue, anchor];
          pairs.push({ line, predecessor, successor });
        }
      }
      const changes = new Map<string, ScheduleDateMutation>();
      for (const { issue: { id, expectedVersion }, changes: requested } of dates) {
        const issue = issuesById.get(id);
        // The endpoint was already checked while assembling the pairs.
        if (!issue || issue.version !== expectedVersion) continue;
        const edit = proposeDateEdit(issue, requested);
        if (!edit) continue;
        const error = hooks.validateChange(issue, edit.change);
        if (error) preview.errors.push({ line: null, issueId: id, key: issue.key, message: error });
        else {
          changes.set(id, edit.change);
          preview.changes.push(omitUnchangedDueDate(includeTeamBlockers ? { ...edit.summary, projectId: issue.projectId } : edit.summary));
        }
      }
      const { linkChanges, projectedLinks, errors, ...review } = prepareBulkDependencyChanges(state.dependencies, pairs, input);
      preview.errors.push(...errors);
      const teamFollowUp = includeTeamBlockers && !preview.errors.length
        ? this.reviewTeamScheduleFollowUps(preview, issuesById, changes, linkChanges, hooks) : null;
      const followUpWarnings = teamFollowUp?.warnings ?? (rescheduleSuccessors && !includeTeamBlockers && !preview.errors.length
        ? reviewScheduleFollowUps(preview, issuesById, projectedLinks, changes, linkChanges, issueIds, hooks) : []);
      const reviewState = teamFollowUp ? mergeScheduleState(state, teamFollowUp.state) : state;
      const reviewedLinks = teamFollowUp ? projectScheduleDependencies(reviewState.dependencies, linkChanges) : projectedLinks;
      const related = affectedLinks(reviewedLinks, changes.keys(), linkChanges);
      const { warnings, missingDateWarnings } = reviewBulkLinkDates(reviewState.issues, related, hooks.warnings, changes);
      preview.warnings = followUpWarnings.length ? [...new Set([...followUpWarnings, ...warnings])] : warnings;
      return this.savePreview({ ...preview, ...review }, state, {
        actorId, issueIds: [...issueIds], changes: [...changes.values()], linkChanges, kind: 'bulk-links',
        ...(teamFollowUp ? { teamFollowUp: teamFollowUp.proposal } : {}),
        ...(followUpWarnings.length ? { followUpWarnings } : {}),
        ...(missingDateWarnings.length ? { missingDateWarnings } : {}),
      }, hooks, reviewState.issues);
    });
  }

  private requireTeamBlockerPair(pair: TeamBlockerPair, hooks: PasteHooks, applying: boolean) {
    const source = this.store.get<Issue>('issues', pair.source.id);
    const target = this.store.get<Issue>('issues', pair.target.id);
    if (!source || !target) throw new SchedulePasteError(applying ? 409 : 404, '차단 관계의 두 업무를 찾을 수 없습니다.');
    if (source.projectId === target.projectId) throw new SchedulePasteError(409, '서로 다른 프로젝트의 업무를 선택해 주세요.');
    if (source.version !== pair.source.expectedVersion || target.version !== pair.target.expectedVersion) {
      throw new SchedulePasteError(409, '차단 관계의 업무가 변경되었습니다. 최신 업무를 불러온 뒤 다시 미리 확인해 주세요.');
    }
    if (hooks.isTerminal(source) || hooks.isTerminal(target)) {
      throw new SchedulePasteError(409, '완료 또는 취소된 업무는 프로젝트 간 차단에 추가할 수 없습니다.');
    }
    return { source, target };
  }

  private previewTeamBlockerEdit(raw: unknown, actorId: string, hooks: PasteHooks): ScheduleTeamBlockerPreview {
    const { rescheduleSuccessors, ...pair } = parseTeamBlockerInput(raw);
    return this.store.transaction(() => {
      this.prune();
      const { source, target } = this.requireTeamBlockerPair(pair, hooks, false);
      const issueIds = [source.id, target.id];
      const scope = this.scopeForIssues(issueIds);
      const state = this.scopeState(scope);
      const changes = new Map<string, ScheduleDateMutation>();
      const review: TeamFollowUpReview = { changes: [], errors: [] };
      const endpoints = [[source, pair.source], [target, pair.target]] as const;
      for (const [issue, endpoint] of endpoints) {
        const edit = proposeDateEdit(issue, endpoint.dates ?? {});
        if (!edit) continue;
        const { change, summary } = edit;
        const { startDate, endDate } = change;
        const error = startDate && endDate && startDate > endDate ? '종료일을 시작일 이후로 지정해 주세요.'
          : hooks.validateChange(issue, change);
        if (error) throw new SchedulePasteError(422, `${issue.key}: ${error}`);
        changes.set(issue.id, change);
        review.changes.push(omitUnchangedDueDate({ ...summary, projectId: issue.projectId }));
      }
      const followUp = rescheduleSuccessors
        ? this.reviewTeamScheduleFollowUps(review, new Map([[source.id, source], [target.id, target]]), changes, [], hooks, {
          proposedBlocker: pair,
          fixedDates: endpoints.flatMap(([issue, endpoint]) => {
            if (!Object.keys(endpoint.dates ?? {}).length) return [];
            const { startDate, endDate } = changes.get(issue.id) ?? issue;
            return [{ id: issue.id, expectedVersion: issue.version, startDate, endDate }];
          }),
        })
        : null;
      const reviewState = followUp ? mergeScheduleState(state, followUp.state) : state;
      const edits = [...changes.values()];
      const projected = reviewState.issues.map(issue => {
        const edit = changes.get(issue.id);
        return edit ? { ...issue, startDate: edit.startDate, endDate: edit.endDate } : issue;
      });
      const warnings = [...hooks.warnings(projected, incidentLinks(reviewState.dependencies, [...issueIds, ...changes.keys()])),
        ...(followUp?.warnings ?? [])];
      const { followUpIssueIds } = review;
      const result = { changes: review.changes, sourceId: source.id, targetId: target.id, ...(followUpIssueIds ? { followUpIssueIds } : {}) };
      if (review.errors.length) {
        const team = this.reviewTeamBlockerDates(reviewState.issues, edits, hooks, { teamBlocker: pair });
        return { ...result, previewId: null, expiresAt: null, errors: review.errors,
          warnings: [...new Set([...warnings, ...(team?.warnings ?? [])])] };
      }
      const saved = this.saveProposal(scope, state, {
        actorId, issueIds, changes: edits, kind: 'team-blocker-edit', teamBlocker: pair,
        ...(followUp ? { teamFollowUp: followUp.proposal } : {}), ...(followUpIssueIds ? { followUpIssueIds } : {}),
      }, hooks, warnings, reviewState.issues);
      return { ...result, previewId: saved.previewId, expiresAt: saved.expiresAt, warnings: saved.warnings ?? warnings };
    });
  }

  private listBlockerLinks(query: Request['query'], hooks: PasteHooks): ScheduleBlockerLinkPage {
    const { projectId, scope, offset: rawOffset = '0' } = query;
    const scopedProject = isRelationId(projectId) && scope === undefined ? projectId : null;
    const team = scope === 'team' && projectId === undefined;
    if ((!scopedProject && !team) || Object.keys(query).some(key => key !== 'projectId' && key !== 'scope' && key !== 'offset') ||
        typeof rawOffset !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(rawOffset) || !Number.isSafeInteger(Number(rawOffset))) {
      throw new SchedulePasteError(400, '프로젝트와 차단 관계 목록 위치를 확인해 주세요.');
    }
    const offset = Number(rawOffset);
    return this.store.transaction(() => {
      if (scopedProject && !this.store.get('projects', scopedProject)) throw new SchedulePasteError(404, '프로젝트를 찾을 수 없습니다.');
      const blockers = hooks.projectBlockers(scopedProject ? [scopedProject] : null);
      if (!blockers.length) return { items: [], offset, total: 0 };
      const issueIds = [...new Set(blockers.flatMap(({ sourceIssueId, targetIssueId }) => [sourceIssueId, targetIssueId]))];
      const rows = this.store.db.prepare(`SELECT id, project_id AS projectId, json_extract(json, '$.key') AS issueKey
        FROM issues WHERE id IN (SELECT value FROM json_each(?))`)
        .all(JSON.stringify(issueIds)) as { id: string; projectId: string; issueKey: string }[];
      const issues = new Map(rows.map(issue => [issue.id, issue]));
      const compare = new Intl.Collator('ko', { numeric: true }).compare;
      const byIssueKey = (left: string, right: string) => compare(issues.get(left)?.issueKey ?? left, issues.get(right)?.issueKey ?? right);
      blockers.sort((left, right) =>
        byIssueKey(left.sourceIssueId, right.sourceIssueId) || byIssueKey(left.targetIssueId, right.targetIssueId) || left.id.localeCompare(right.id));
      const page = blockers.slice(offset, offset + SCHEDULE_BLOCKER_LINK_PAGE_SIZE);
      return {
        items: team ? page.map(blocker => ({ ...blocker, projectId: issues.get(blocker.sourceIssueId)!.projectId })) : page,
        offset, total: blockers.length,
      };
    });
  }

  private previewBlockerLinks(raw: unknown, actorId: string, hooks: PasteHooks): SchedulePastePreview {
    const { projectId, relations } = parseBlockerLinkInput(raw);
    return this.store.transaction(() => {
      if (projectId !== null && !this.store.get('projects', projectId)) throw new SchedulePasteError(404, '프로젝트를 찾을 수 없습니다.');
      this.prune();
      const projectIds = projectId === null
        ? [...new Set(relations.map(relation => relation.projectId))].filter(id => this.store.get('projects', id)).sort()
        : [projectId];
      const scope = projectId === null ? { projectId, projectIds } : { projectId };
      const state = this.scopeState(scope);
      const issuesById = new Map(state.issues.map(issue => [issue.id, issue]));
      const blockersById = new Map(hooks.projectBlockers(projectIds).map(relation => [relation.id, relation]));
      const existingPairs = new Set(state.dependencies.map(link => dependencyPair(link.predecessorId, link.successorId)));
      const selectionErrors: SchedulePastePreview['errors'] = [];
      const reviewedRelations: ScheduleBlockerLinkCandidate[] = [];
      const issueIds = new Set<string>();
      const pairs: DependencyCandidate[] = [];
      for (const [index, requested] of relations.entries()) {
        const line = index + 1;
        const relation = blockersById.get(requested.id);
        const predecessor = relation && issuesById.get(relation.sourceIssueId);
        const successor = relation && issuesById.get(relation.targetIssueId);
        if (!relation || relation.version !== requested.version || predecessor?.projectId !== requested.projectId || successor?.projectId !== requested.projectId) {
          selectionErrors.push({ line, message: '선택한 차단 관계가 변경되었거나 지정한 프로젝트에서 확인할 수 없습니다. 목록을 다시 불러와 주세요.' });
          continue;
        }
        if (!existingPairs.has(dependencyPair(predecessor.id, successor.id)) && existingPairs.has(dependencyPair(successor.id, predecessor.id))) {
          selectionErrors.push({ line, message: `${predecessor.key} → ${successor.key}: 반대 방향의 간트 연결이 있어 순환 관계가 생깁니다.` });
          continue;
        }
        const rowProject = projectId === null ? { projectId: requested.projectId } : {};
        reviewedRelations.push({ ...relation, ...rowProject });
        issueIds.add(predecessor.id);
        issueIds.add(successor.id);
        pairs.push({ line, predecessor, successor, ...rowProject });
      }
      const { linkChanges, projectedLinks, errors, ...review } = prepareBulkDependencyChanges(state.dependencies, pairs, { type: 'FS', lagDays: 0 });
      const { warnings, missingDateWarnings } = reviewBulkLinkDates(state.issues, affectedLinks(projectedLinks, [], linkChanges), hooks.warnings);
      return this.savePreview({
        ...scope, previewId: null, expiresAt: null, changes: [], warnings, ...review, errors: [...selectionErrors, ...errors],
      }, state, {
        actorId, issueIds: [...issueIds], changes: [], linkChanges, kind: 'blocker-links', blockerRelations: reviewedRelations,
        ...(missingDateWarnings.length ? { missingDateWarnings } : {}),
      }, hooks);
    });
  }

  private apply(request: Request, previewId: unknown, hooks: PasteHooks, kind?: PasteProposal['kind']): SchedulePasteApplyResult {
    if (typeof previewId !== 'string' || !previewId || previewId.length > 200) {
      throw new SchedulePasteError(400, '적용할 미리보기 ID가 필요합니다.');
    }
    const actorId = hooks.actor(request);
    return this.store.transaction(() => {
      const proposal = this.store.get<PasteProposal>(table, previewId);
      if (!proposal || proposal.kind !== kind) throw new SchedulePasteError(404, '미리보기가 없거나 만료되었습니다.');
      if (proposal.actorId !== actorId) throw new SchedulePasteError(409, '미리보기를 만든 작업자가 적용해 주세요.');
      if (proposal.removeAfter <= after(0)) throw new SchedulePasteError(409, '미리보기가 만료되었습니다. 다시 확인해 주세요.');
      if (proposal.result) return proposal.result;
      const teamBlocker = kind === 'team-blocker-edit' ? proposal.teamBlocker : undefined;
      if (kind === 'team-blocker-edit' && !teamBlocker) throw new SchedulePasteError(404, '미리보기가 없거나 만료되었습니다.');
      if (teamBlocker) this.requireTeamBlockerPair(teamBlocker, hooks, true);
      if (proposal.keyBindings) {
        const keys = this.workspaceKeys(new Set(proposal.keyBindings.map(({ key }) => key)));
        if (proposal.keyBindings.some(binding => {
          const current = keys.get(binding.key);
          return current?.id !== binding.id || current.projectId !== binding.projectId;
        })) throw new SchedulePasteError(409, '업무 키 또는 업무의 프로젝트가 변경되었습니다. 다시 미리 확인해 주세요.');
      }
      if (proposal.resolvedKeyBindings) {
        const resolved = this.resolvePasteKeys(proposal.projectId, new Set(proposal.resolvedKeyBindings.map(({ inputKey }) => inputKey)));
        if (proposal.resolvedKeyBindings.some(binding => {
          const current = resolved.get(binding.inputKey);
          return current?.id !== binding.id || current.projectId !== binding.projectId || current.key !== binding.key ||
            current.source !== binding.source || current.currentKeyConflict !== binding.currentKeyConflict;
        })) throw new SchedulePasteError(409, '업무 키 또는 업무의 프로젝트가 변경되었습니다. 다시 미리 확인해 주세요.');
      }
      const state = this.scopeState(proposal);
      const linkChanges = proposal.linkChanges ?? [];
      const teamFollowUp = proposal.teamFollowUp && this.teamFollowUpContext(proposal.teamFollowUp.anchors, hooks, {
        applying: true, linkChanges, successorIds: proposal.teamFollowUp.successorIds, proposedBlocker: teamBlocker,
      });
      if (teamFollowUp && teamFollowUp.guard !== proposal.teamFollowUp?.guard) {
        throw new SchedulePasteError(409, '프로젝트 간 후행 업무, 연결 또는 프로젝트 규칙이 변경되었습니다. 다시 미리 확인해 주세요.');
      }
      let reviewState = state;
      if (teamFollowUp) reviewState = kind === 'manual-edit' ? teamFollowUp.state : mergeScheduleState(state, teamFollowUp.state);
      if (proposal.incomingTeamBlockerGuard) {
        // Older pending previews stored only the selected row's guard.
        const guards = typeof proposal.incomingTeamBlockerGuard === 'string'
          ? [[proposal.issueIds[0], proposal.incomingTeamBlockerGuard]] : proposal.incomingTeamBlockerGuard;
        if (guards.some(([id, hash]) => {
          const target = state.issues.find(issue => issue.id === id);
          return !target || incomingTeamBlockerGuard(this.incomingTeamBlockers(target, hooks)) !== hash;
        })) {
          throw new SchedulePasteError(409, '프로젝트 간 선행 업무 또는 차단 관계가 변경되었습니다. 최신 업무를 불러온 뒤 다시 미리 확인해 주세요.');
        }
      }
      const team = this.reviewTeamBlockerDates(reviewState.issues, proposal.changes, hooks, proposal);
      if (proposal.teamBlockerGuard ? team?.guard !== proposal.teamBlockerGuard : team?.relationCount) {
        throw new SchedulePasteError(409, '프로젝트 간 연결 업무 또는 차단 관계가 변경되었습니다. 최신 업무를 불러온 뒤 다시 미리 확인해 주세요.');
      }
      if (kind === 'blocker-links') {
        const reviewed = proposal.blockerRelations ?? [];
        const projectIds = proposal.projectId === null ? proposal.projectIds ?? [] : [proposal.projectId];
        const current = new Map(hooks.projectBlockers(projectIds).map(relation => [relation.id, relation]));
        const issueProjects = new Map(state.issues.map(issue => [issue.id, issue.projectId]));
        if (!reviewed.length || reviewed.some(relation => {
          const live = current.get(relation.id);
          const projectId = proposal.projectId ?? relation.projectId;
          return !live || live.version !== relation.version || live.origin !== relation.origin ||
            live.sourceIssueId !== relation.sourceIssueId || live.targetIssueId !== relation.targetIssueId ||
            !projectId || issueProjects.get(live.sourceIssueId) !== projectId || issueProjects.get(live.targetIssueId) !== projectId;
        })) throw new SchedulePasteError(409, '차단 관계 또는 원본 방향이 변경되었습니다. 다시 미리 확인해 주세요.');
      }
      if (proposal.hierarchyId) {
        const trace = traceGanttHierarchy(proposal.hierarchyId, state.issues, () => 'backlog');
        const reviewedIds = new Set(proposal.hierarchyIssueIds ?? proposal.issueIds);
        if (!trace || trace.issues.length !== reviewedIds.size || trace.issues.some(issue => !reviewedIds.has(issue.id))) {
          throw new SchedulePasteError(409, '상위·하위 업무 구성이 변경되었습니다. 다시 미리 확인해 주세요.');
        }
      }
      if (this.guard(proposal, state, proposal.issueIds, hooks) !== proposal.guard) {
        throw new SchedulePasteError(409, '업무, 연결된 일정 또는 프로젝트 규칙이 변경되었습니다. 다시 미리 확인해 주세요.');
      }
      const { dependencies } = reviewState;
      const projectedLinks = linkChanges.length ? projectScheduleDependencies(dependencies, linkChanges) : dependencies;
      if (linkChanges.some(addsScheduleDependencyPair) && hasScheduleDependencyCycle(projectedLinks)) {
        throw new SchedulePasteError(409, '업무 연결이 변경되어 순환 관계가 생깁니다. 다시 미리 확인해 주세요.');
      }
      const changedIds = proposal.changes.map(change => change.id);
      const links = affectedLinks(projectedLinks, teamBlocker ? [...proposal.issueIds, ...changedIds] : changedIds, linkChanges);
      const result = teamBlocker ? { ...hooks.commitTeamBlocker(request, teamBlocker, proposal.changes, links),
        ...(proposal.followUpIssueIds ? { followUpIssueIds: proposal.followUpIssueIds } : {}) }
        : hooks.commitChanges(request, proposal.changes, links, linkChanges, {
        projectId: proposal.projectId ?? (teamFollowUp && proposal.projectIds?.length === 1 ? proposal.projectIds[0] : undefined),
        // The selected row heads the guarded read set even when only successors or links change.
        issueId: proposal.kind === 'row-edit' ? proposal.issueIds[0] : undefined,
      });
      if (proposal.followUpWarnings || proposal.missingDateWarnings || proposal.teamBlockerWarnings) {
        result.warnings = [...new Set([...(proposal.followUpWarnings ?? []), ...(proposal.missingDateWarnings ?? []),
          ...result.warnings, ...(proposal.teamBlockerWarnings ?? [])])];
      }
      this.store.put(table, {...proposal,removeAfter:after(AUTO_RESULT_RETENTION_MS),result});
      return result;
    });
  }

  registerRoutes(app: Express, hooks: PasteHooks) {
    app.post('/api/schedule/manual-preview', (req, res) => {
      res.set('Cache-Control', 'no-store').json(this.previewManual(req.body, hooks.actor(req), hooks));
    });
    app.post('/api/schedule/manual-apply', (req, res) => {
      if (!isRecord(req.body) || Object.keys(req.body).length !== 1) {
        throw new SchedulePasteError(400, '적용할 일정 미리보기 ID를 확인해 주세요.');
      }
      res.set('Cache-Control', 'no-store').json(this.apply(req, req.body.previewId, hooks, 'manual-edit'));
    });
    app.post('/api/schedule/paste-preview', (req, res) => {
      if (!isRecord(req.body)) throw new SchedulePasteError(400, '후행 일정 검토 여부를 확인해 주세요.');
      const options = parsePasteFollowUpOptions(req.body);
      res.json(this.preview(req.body.projectId, req.body.text, parseSheetChoices(req.body.sheetChoices), hooks.actor(req), hooks, options));
    });
    app.post('/api/schedule/paste-apply', (req, res) => {
      res.json(this.apply(req, req.body.previewId, hooks));
    });
    app.post('/api/schedule/bulk-dates/preview', (req, res) => {
      res.set('Cache-Control', 'no-store').json(this.previewBulkDates(req.body, hooks.actor(req), hooks));
    });
    app.post('/api/schedule/bulk-dates/apply', (req, res) => {
      if (!isRecord(req.body) || Object.keys(req.body).length !== 1) {
        throw new SchedulePasteError(400, '적용할 일정 미리보기 ID를 확인해 주세요.');
      }
      res.set('Cache-Control', 'no-store').json(this.apply(req, req.body.previewId, hooks, 'bulk-dates'));
    });
    app.post('/api/schedule/bulk-links/preview', (req, res) => {
      res.set('Cache-Control', 'no-store').json(this.previewBulkLinks(req.body, hooks.actor(req), hooks));
    });
    app.post('/api/schedule/bulk-links/apply', (req, res) => {
      if (!isRecord(req.body) || Object.keys(req.body).length !== 1) {
        throw new SchedulePasteError(400, '적용할 일정 미리보기 ID를 확인해 주세요.');
      }
      res.set('Cache-Control', 'no-store').json(this.apply(req, req.body.previewId, hooks, 'bulk-links'));
    });
    app.get('/api/schedule/blocker-links', (req, res) => {
      hooks.actor(req);
      res.set('Cache-Control', 'no-store').json(this.listBlockerLinks(req.query, hooks));
    });
    app.post('/api/schedule/blocker-links/preview', (req, res) => {
      res.set('Cache-Control', 'no-store').json(this.previewBlockerLinks(req.body, hooks.actor(req), hooks));
    });
    app.post('/api/schedule/blocker-links/apply', (req, res) => {
      if (!isRecord(req.body) || Object.keys(req.body).length !== 1) {
        throw new SchedulePasteError(400, '적용할 일정 미리보기 ID를 확인해 주세요.');
      }
      res.set('Cache-Control', 'no-store').json(this.apply(req, req.body.previewId, hooks, 'blocker-links'));
    });
    app.post('/api/schedule/team-blocker-edit/preview', (req, res) => {
      res.set('Cache-Control', 'no-store').json(this.previewTeamBlockerEdit(req.body, hooks.actor(req), hooks));
    });
    app.post('/api/schedule/team-blocker-edit/apply', (req, res) => {
      if (!isRecord(req.body) || Object.keys(req.body).length !== 1) {
        throw new SchedulePasteError(400, '적용할 일정 미리보기 ID를 확인해 주세요.');
      }
      res.set('Cache-Control', 'no-store').json(this.apply(req, req.body.previewId, hooks, 'team-blocker-edit'));
    });
    app.post('/api/schedule/row-edit/preview', (req, res) => {
      res.set('Cache-Control', 'no-store').json(this.previewRowEdit(req.body, hooks.actor(req), hooks));
    });
    app.post('/api/schedule/row-edit/apply', (req, res) => {
      if (!isRecord(req.body) || Object.keys(req.body).length !== 1) {
        throw new SchedulePasteError(400, '적용할 일정 미리보기 ID를 확인해 주세요.');
      }
      res.set('Cache-Control', 'no-store').json(this.apply(req, req.body.previewId, hooks, 'row-edit'));
    });
  }
}
