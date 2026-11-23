import { createHash, randomUUID } from 'node:crypto';
import type { Express, Request } from 'express';
import { CalendarError, MAX_WORKING_DURATION_DAYS, calendarDate, calendarDay, createCalendarMath, isCalendarDate } from '../shared/calendar.js';
import { traceGanttHierarchy } from '../shared/gantt-hierarchy-focus.js';
import { isRelationId } from '../shared/issue-relations.js';
import { MAX_SCHEDULE_BLOCKER_LINKS, MAX_SCHEDULE_BULK_DATE_ISSUES, MAX_SCHEDULE_BULK_LINK_ISSUES, MAX_SCHEDULE_MANUAL_ISSUES, MAX_SCHEDULE_ROW_DEPENDENCY_EDITS, SCHEDULE_BLOCKER_LINK_PAGE_SIZE, type Dependency, type Issue, type ScheduleBlockerLinkCandidate, type ScheduleBlockerLinkPage, type ScheduleBulkDateChanges, type ScheduleBulkDateInput, type ScheduleBulkLinkInput,
  type ScheduleChange, type ScheduleManualPreviewInput, type SchedulePasteApplyResult, type SchedulePasteDependencyChange, type SchedulePastePreview, type SchedulePreview,
  type ScheduleRowDependencyEdit, type ScheduleRowEditInput, type ProjectWorkflow, type TeamScheduleBlocker, type WorkCalendar } from '../shared/types.js';
import { DEPENDENCY_ENDPOINTS, SCHEDULE_DATE_LABELS, dependencyGuardFields, isDependencyLag, isDependencyType } from '../shared/schedule-dependencies.js';
import { AUTO_PREVIEW_TTL_MS, AUTO_RESULT_RETENTION_MS, calculateFixedFollowUpSchedule, type AutomaticScheduleMutation, type ScheduleUndoOrigin } from './automatic-schedule.js';
import { dependencyPair, hasScheduleDependencyCycle, projectScheduleDependencies, type ScheduleDependencyMutation } from './schedule-dependency-changes.js';
import { parseSchedulePaste, type SchedulePasteRow } from './schedule-paste-parser.js';
import type { Store } from './store.js';

export class SchedulePasteError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

interface ScheduleVersions {
  calendar: number;
  workflow: number;
  schema: number;
}

export type ScheduleDateMutation = AutomaticScheduleMutation & Partial<Pick<Issue, 'dueDate'>>;

interface PasteHooks {
  actor(request: Request): string;
  versions(projectId: string): ScheduleVersions;
  calendar(projectId: string): WorkCalendar;
  workflow(projectId: string): ProjectWorkflow;
  validateChange(issue: Issue, change: ScheduleDateMutation): string | null;
  warnings(issues: Issue[], dependencies: Dependency[]): string[];
  projectBlockers(projectIds: readonly string[] | null): TeamScheduleBlocker[];
  commitChanges(request: Request, changes: ScheduleDateMutation[], dependencies: Dependency[], linkChanges: ScheduleDependencyMutation[],
    origin: ScheduleUndoOrigin): SchedulePasteApplyResult;
}

type ScheduleScope = Pick<SchedulePastePreview, 'projectId' | 'projectIds'>;

interface ScheduleState {
  issues: Issue[];
  dependencies: Dependency[];
}

type ScheduleKeyBinding = Pick<Issue, 'id' | 'projectId' | 'key'>;

interface PasteProposal extends ScheduleScope {
  id: string;
  actorId: string;
  removeAfter: string;
  issueIds: string[];
  keyBindings?: ScheduleKeyBinding[];
  hierarchyId?: string;
  guard: string;
  changes: ScheduleDateMutation[];
  linkChanges?: ScheduleDependencyMutation[];
  followUpWarnings?: string[];
  missingDateWarnings?: string[];
  blockerRelations?: ScheduleBlockerLinkCandidate[];
  kind?: 'bulk-dates' | 'bulk-links' | 'blocker-links' | 'row-edit' | 'manual-edit';
  result?: SchedulePasteApplyResult;
}

type ProposalDraft = Pick<PasteProposal, 'actorId' | 'issueIds' | 'keyBindings' | 'hierarchyId' | 'changes' | 'linkChanges' | 'kind' | 'followUpWarnings' | 'missingDateWarnings' | 'blockerRelations'>;

type DependencyAddition = { line: number; predecessor: Issue; successor: Issue; projectId?: string };
type ScopedBlockerReference = Pick<TeamScheduleBlocker, 'id' | 'version'> & { projectId: string };

const table = 'schedule_paste_previews';
const after = (ms: number) => new Date(Date.now() + ms).toISOString();
const dateFields = { startDate: '시작일', endDate: '종료일', dueDate: '목표 마감일' };

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

function parseBulkDateInput(raw: unknown): ScheduleBulkDateInput {
  if (!isRecord(raw) || Object.keys(raw).length !== 3 || (raw.projectId !== null && !isId(raw.projectId))) {
    throw new SchedulePasteError(400, '프로젝트와 일정 일괄 변경 항목을 확인해 주세요.');
  }
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
  return { projectId: raw.projectId, issues, changes: parseDateChanges(raw.changes) };
}

function parseBulkLinkInput(raw: unknown): ScheduleBulkLinkInput {
  if (!isRecord(raw) || Object.keys(raw).length !== 6 || !isId(raw.projectId) ||
      (raw.direction !== 'predecessor' && raw.direction !== 'successor')) {
    throw new SchedulePasteError(400, '프로젝트와 일괄 연결 방향을 확인해 주세요.');
  }
  if (!isDependencyType(raw.type) || !isDependencyLag(raw.lagDays)) {
    throw new SchedulePasteError(400, '업무 연결 유형과 -3650~3650 사이의 정수 근무일 간격을 확인해 주세요.');
  }
  if (!Array.isArray(raw.issues) || raw.issues.length < 2 || raw.issues.length > MAX_SCHEDULE_BULK_LINK_ISSUES) {
    throw new SchedulePasteError(400, `한 프로젝트에서 업무를 2~${MAX_SCHEDULE_BULK_LINK_ISSUES}개 선택해 주세요.`);
  }
  const anchor = parseScheduleIssue(raw.anchor);
  const issues = raw.issues.map(parseScheduleIssue);
  const ids = new Set(issues.map(issue => issue.id));
  if (ids.size !== issues.length || ids.has(anchor.id)) {
    throw new SchedulePasteError(400, '기준 업무와 선택 업무는 각각 한 번만 지정해 주세요.');
  }
  return { projectId: raw.projectId, anchor, issues, direction: raw.direction, type: raw.type, lagDays: raw.lagDays };
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
  if (Object.hasOwn(raw, 'changes')) {
    if (Object.keys(raw).some(key => key !== 'changes' && key !== 'rescheduleSuccessors') ||
        (Object.hasOwn(raw, 'rescheduleSuccessors') && typeof raw.rescheduleSuccessors !== 'boolean') ||
        !Array.isArray(raw.changes) || !raw.changes.length || raw.changes.length > MAX_SCHEDULE_MANUAL_ISSUES) throw invalid();
    const changes = Array.from(raw.changes, (value: unknown) => {
      if (!isRecord(value) || Object.keys(value).length !== 4) throw invalid();
      const { id, expectedVersion, startDate, endDate } = value;
      if (!isId(id) || !isVersion(expectedVersion) || (startDate !== null && !isCalendarDate(startDate)) ||
          (endDate !== null && !isCalendarDate(endDate))) throw invalid();
      return { id, expectedVersion, startDate, endDate };
    });
    if (new Set(changes.map(change => change.id)).size !== changes.length) throw invalid();
    return { changes, ...(raw.rescheduleSuccessors === true ? { rescheduleSuccessors: true } : {}) };
  }
  const { issueIds, days, workingDays } = raw;
  if (Object.keys(raw).length !== 3 || typeof days !== 'number' || !Number.isSafeInteger(days) ||
      Math.abs(days) > MAX_WORKING_DURATION_DAYS || typeof workingDays !== 'boolean') throw invalid();
  if (Object.hasOwn(raw, 'hierarchy')) return { hierarchy: parseScheduleIssue(raw.hierarchy), days, workingDays };
  if (!Array.isArray(issueIds) || !issueIds.length || issueIds.length > MAX_SCHEDULE_MANUAL_ISSUES ||
      !issueIds.every(isId) || new Set(issueIds).size !== issueIds.length) throw invalid();
  return { issueIds, days, workingDays };
}

function parseRowDependencyEdit(raw: unknown): ScheduleRowDependencyEdit {
  const invalid = () => new SchedulePasteError(400, '업무 연결 변경 항목을 확인해 주세요.');
  if (!isRecord(raw)) throw invalid();
  const { action, id, expectedVersion, direction, type, lagDays } = raw;
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
  if (action === 'update' && validKeys(['id', 'expectedVersion', 'type', 'lagDays']) && isId(id) && isVersion(expectedVersion)) {
    return { action, id, expectedVersion, relatedIssue, type, lagDays };
  }
  throw invalid();
}

function parseRowEditInput(raw: unknown): Pick<ScheduleRowEditInput, 'projectId' | 'issue' | 'changes'> & {
  linkEdits: { line: number | null; input: ScheduleRowDependencyEdit }[];
  rescheduleSuccessors: boolean;
} {
  if (!isRecord(raw) || !isId(raw.projectId) ||
    Object.keys(raw).some(key => !['projectId', 'issue', 'changes', 'dependency', 'dependencies', 'rescheduleSuccessors'].includes(key)) ||
    (Object.hasOwn(raw, 'rescheduleSuccessors') && typeof raw.rescheduleSuccessors !== 'boolean') ||
    (Object.hasOwn(raw, 'dependency') && Object.hasOwn(raw, 'dependencies'))) {
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
  return {
    projectId: raw.projectId,
    issue: parseScheduleIssue(raw.issue),
    changes: raw.changes === undefined ? {} : parseDateChanges(raw.changes, true),
    linkEdits,
    rescheduleSuccessors: raw.rescheduleSuccessors === true,
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
{ pair: string; mutation: ScheduleDependencyMutation | null } | { error: string } {
  if (issue.id === related.id) return { error: '자기 자신에게 의존할 수 없습니다.' };
  if (input.action === 'add') {
    const [predecessorId, successorId] = input.direction === 'predecessor' ? [related.id, issue.id] : [issue.id, related.id];
    const pair = dependencyPair(predecessorId, successorId);
    if (byPair.has(pair)) {
      return { error: '이미 연결된 의존성입니다. 기존 업무 연결을 선택해 주세요.' };
    }
    const after = { id: randomUUID(), predecessorId, successorId, type: input.type, lagDays: input.lagDays };
    return { pair, mutation: { before: null, after } };
  }
  const before = byId.get(input.id);
  if (!before || !((before.predecessorId === issue.id && before.successorId === related.id) ||
      (before.predecessorId === related.id && before.successorId === issue.id))) {
    return { error: '선택한 두 업무 사이의 연결을 찾을 수 없습니다. 연결을 다시 확인해 주세요.' };
  }
  if ((before.version ?? 1) !== input.expectedVersion) return { error: '업무 연결이 변경되었습니다. 최신 연결을 다시 확인해 주세요.' };
  const pair = dependencyPair(before.predecessorId, before.successorId);
  if (input.action === 'remove') return { pair, mutation: { before, after: null } };
  if (before.type === input.type && before.lagDays === input.lagDays) return { pair, mutation: null };
  return { pair, mutation: { before, after: { ...before, type: input.type, lagDays: input.lagDays } } };
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

function prepareLinkAdditions(state: ScheduleState, pairs: DependencyAddition[], settings: Pick<Dependency, 'type' | 'lagDays'>,
  calculateWarnings: PasteHooks['warnings']) {
  const dependencyChanges: SchedulePasteDependencyChange[] = [];
  const retainedDependencies: SchedulePasteDependencyChange[] = [];
  const linkChanges: ScheduleDependencyMutation[] = [];
  const missingDateWarnings: string[] = [];
  const errors: SchedulePastePreview['errors'] = [];
  const linksByPair = new Map(state.dependencies.map(link => [dependencyPair(link.predecessorId, link.successorId), link]));
  const endpoints = DEPENDENCY_ENDPOINTS[settings.type];
  for (const { line, predecessor, successor, projectId } of pairs) {
    const summary = { line, predecessorKey: predecessor.key, predecessorTitle: predecessor.title,
      successorKey: successor.key, successorTitle: successor.title, ...(projectId ? { projectId } : {}) };
    const existing = linksByPair.get(dependencyPair(predecessor.id, successor.id));
    if (existing) {
      const saved = { type: existing.type, lagDays: existing.lagDays };
      retainedDependencies.push({ ...summary, before: saved, after: saved });
      continue;
    }
    linkChanges.push({ before: null, after: { id: randomUUID(), predecessorId: predecessor.id, successorId: successor.id, ...settings } });
    dependencyChanges.push({ ...summary, before: null, after: settings });
    const missingDates: string[] = [];
    if (!predecessor[endpoints.predecessor]) missingDates.push(`${predecessor.key} ${SCHEDULE_DATE_LABELS[endpoints.predecessor]}`);
    if (!successor[endpoints.successor]) missingDates.push(`${successor.key} ${SCHEDULE_DATE_LABELS[endpoints.successor]}`);
    if (missingDates.length) missingDateWarnings.push(`${predecessor.key} → ${successor.key} · 날짜 미정 (${missingDates.join(', ')})`);
  }

  const warnings = [...missingDateWarnings];
  if (linkChanges.length) {
    const projected = projectScheduleDependencies(state.dependencies, linkChanges);
    if (hasScheduleDependencyCycle(projected)) {
      errors.push({ line: null, message: '적용할 업무 연결에 순환 관계가 있습니다. 연결 방향을 확인해 주세요.' });
    }
    warnings.push(...calculateWarnings(state.issues, affectedLinks(projected, [], linkChanges)));
  }
  return { dependencyChanges, retainedDependencies, unchanged: retainedDependencies.length, warnings, errors, linkChanges, missingDateWarnings };
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

  private guard(scope: ScheduleScope & Pick<PasteProposal, 'kind' | 'hierarchyId'>, { issues, dependencies }: ScheduleState, targetIds: string[], hooks: PasteHooks) {
    const links = incidentLinks(dependencies, targetIds);
    const related = new Set([...targetIds, ...links.flatMap(link => [link.predecessorId, link.successorId])]);
    // Keep the original single-project guard encoding for existing pending previews.
    const issueVersions = issues.filter(issue => related.has(issue.id)).sort((a, b) => a.id.localeCompare(b.id))
      .map(issue => {
        if (scope.kind === 'manual-edit') return [issue.id, issue.version, issue.projectId, issue.startDate, issue.endDate,
          ...(scope.hierarchyId ? [issue.parentId ?? null, issue.status] : [])];
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
    proposal: ProposalDraft, hooks: PasteHooks): SchedulePastePreview {
    if (preview.errors.length || (!proposal.changes.length && !proposal.linkChanges?.length)) return preview;
    return { ...preview, ...this.saveProposal(preview, state, proposal, hooks) };
  }

  private saveProposal(scope: ScheduleScope, state: ScheduleState, proposal: ProposalDraft, hooks: PasteHooks) {
    const id = randomUUID();
    const expiresAt = after(AUTO_PREVIEW_TTL_MS);
    this.store.put(table, {
      ...proposal, id, projectId: scope.projectId, removeAfter: expiresAt,
      ...(scope.projectIds ? { projectIds: scope.projectIds } : {}),
      guard: this.guard({ ...scope, kind: proposal.kind, hierarchyId: proposal.hierarchyId }, state, proposal.issueIds, hooks),
    } satisfies PasteProposal);
    return { previewId: id, expiresAt };
  }

  private previewManual(raw: unknown, actorId: string, hooks: PasteHooks): SchedulePreview {
    const input = parseManualPreviewInput(raw);
    const shift = 'changes' in input ? null : input;
    const followUp = 'changes' in input && input.rescheduleSuccessors ? input.changes : null;
    const hierarchy = 'hierarchy' in input ? input.hierarchy : null;
    const shiftTarget = (id: string) => ({ id, expectedVersion: undefined, startDate: null, endDate: null });
    return this.store.transaction(() => {
      this.prune();
      const anchor = hierarchy ? this.store.get<Issue>('issues', hierarchy.id) : null;
      if (hierarchy && !anchor) throw new SchedulePasteError(404, '상위 업무가 삭제되었거나 존재하지 않습니다. 업무를 다시 선택해 주세요.');
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
          preview.changes.push(omitUnchangedDueDate(edit.summary));
        }
      };
      for (const { id, expectedVersion, startDate, endDate } of selected) {
        const issue = byId.get(id);
        if (!issue) throw new SchedulePasteError(404, '선택한 업무가 삭제되었거나 존재하지 않습니다. 업무를 다시 선택해 주세요.');
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
      const issueIds = new Set(selected.map(({ id }) => id));
      const followUpWarnings: string[] = [];
      if (followUp && !blocking.length) {
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
          blocking.push(...plan.blocking);
          followUpWarnings.push(...plan.warnings);
          const anchorIds = new Set(anchors.map(({ id }) => id));
          for (const { id, toStart, toEnd } of plan.changes) {
            if (!anchorIds.has(id)) addDateChange(byId.get(id)!, { startDate: toStart, endDate: toEnd });
          }
        }
        if (changes.size > MAX_SCHEDULE_MANUAL_ISSUES) {
          blocking.push(`한 번에 변경할 수 있는 업무는 ${MAX_SCHEDULE_MANUAL_ISSUES}개입니다. 범위를 나누어 미리 확인해 주세요.`);
        }
        for (const { id, key, toEnd } of preview.changes) {
          const dueDate = byId.get(id)?.dueDate;
          if (toEnd && dueDate && toEnd > dueDate) followUpWarnings.push(`${key}: 제안한 종료일 ${toEnd}이 목표 마감일 ${dueDate}보다 늦습니다.`);
        }
      }
      if (changes.size) {
        const projected = state.issues.map(issue => {
          const change = changes.get(issue.id);
          return change ? { ...issue, startDate: change.startDate, endDate: change.endDate } : issue;
        });
        preview.warnings.push(...hooks.warnings(projected, incidentLinks(state.dependencies, changes.keys())));
      }
      if (followUpWarnings.length) preview.warnings = [...new Set([...followUpWarnings, ...preview.warnings])];
      if (blocking.length) return { ...preview, blocking: [...new Set(blocking)] };
      if (!changes.size) return preview;
      return { ...preview, ...this.saveProposal(scope, state, {
        actorId, issueIds: [...issueIds], changes: [...changes.values()], kind: 'manual-edit',
        ...(hierarchy ? { hierarchyId: hierarchy.id } : {}),
        ...(followUpWarnings.length ? { followUpWarnings } : {}),
      }, hooks) };
    });
  }

  private preview(projectId: unknown, raw: unknown, actorId: string, hooks: PasteHooks): SchedulePastePreview {
    if (projectId !== null && (typeof projectId !== 'string' || !projectId || projectId.length > 200)) {
      throw new SchedulePasteError(400, '붙여넣을 프로젝트를 선택해 주세요.');
    }
    const parsed = parseSchedulePaste(raw);
    return this.store.transaction(() => {
      if (projectId !== null && !this.store.get('projects', projectId)) throw new SchedulePasteError(404, '프로젝트를 찾을 수 없습니다.');
      this.prune();
      const keys = projectId === null
        ? this.workspaceKeys(new Set(parsed.rows.flatMap(({ key, dependency }) => dependency ? [key, dependency.predecessorKey] : [key])))
        : null;
      const projectIds = keys && [...new Set([...keys.values()].flatMap(binding => binding ? [binding.projectId] : []))].sort();
      const scope = { projectId, ...(projectIds ? { projectIds } : {}) };
      const state = this.scopeState(scope);
      const {issues, dependencies} = state;
      const byKey = new Map<string, Issue | null>();
      if (keys) {
        const byId = new Map(issues.map(issue => [issue.id, issue]));
        for (const [key, binding] of keys) byKey.set(key, binding ? byId.get(binding.id) ?? null : null);
      } else {
        for (const issue of issues) {
          const key = issue.key.toUpperCase();
          byKey.set(key, byKey.has(key) ? null : issue);
        }
      }
      const scopeLabel = projectId === null ? '전체 프로젝트에' : '이 프로젝트에';
      const dependencyChanges: SchedulePasteDependencyChange[] = [];
      const preview: SchedulePastePreview = {
        ...scope, previewId:null, expiresAt:null, changes:[], dependencyChanges, warnings:[], errors:parsed.errors, unchanged:0,
      };
      const changes = new Map<string, ScheduleDateMutation>();
      const linkChanges: ScheduleDependencyMutation[] = [];
      const byPair = new Map(dependencies.map(link => [dependencyPair(link.predecessorId, link.successorId), link]));
      const targetIds = new Set<string>();
      const resolvedRows: { row: SchedulePasteRow; issue: Issue; datesChanged: boolean }[] = [];
      const requestedDates = new Map<string, { issue: Issue; line: number; dates: ScheduleBulkDateChanges }>();
      for (const row of parsed.rows) {
        const issue = byKey.get(row.key);
        if (!issue) {
          const message = issue === null ? `${scopeLabel} 동일한 업무 키가 두 개 이상 있습니다.` : `${scopeLabel} 해당 업무 키가 없습니다.`;
          preview.errors.push({line:row.line,key:row.key,message});
          continue;
        }
        const { startDate, endDate, dueDate } = row;
        const datesChanged = (startDate !== undefined && startDate !== issue.startDate) ||
          (endDate !== undefined && endDate !== issue.endDate) ||
          (dueDate !== undefined && dueDate !== (issue.dueDate ?? null));
        resolvedRows.push({ row, issue, datesChanged });
        if (!datesChanged) continue;
        const previous = requestedDates.get(issue.id);
        const dates = previous?.dates ?? {};
        if (startDate !== undefined) dates.startDate = startDate;
        if (endDate !== undefined) dates.endDate = endDate;
        if (dueDate !== undefined) dates.dueDate = dueDate;
        requestedDates.set(issue.id, {
          issue, line: previous?.line ?? row.line, dates,
        });
      }

      const invalidDates = new Set<string>();
      for (const { issue, line, dates } of requestedDates.values()) {
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
        preview.changes.push(omitUnchangedDueDate(projectId === null ? { ...summary, projectId: issue.projectId } : summary));
      }

      for (const { row, issue, datesChanged } of resolvedRows) {
        if (invalidDates.has(issue.id)) continue;
        targetIds.add(issue.id);
        const input = row.dependency;
        if (input) {
          const predecessor = byKey.get(input.predecessorKey);
          if (!predecessor || predecessor.id === issue.id) {
            const message = predecessor === null ? `선행 업무 키 ${input.predecessorKey}가 ${scopeLabel} 중복되어 있습니다.`
              : predecessor ? '자기 자신에게 의존할 수 없습니다.' : `${scopeLabel} 선행 업무 키 ${input.predecessorKey}가 없습니다.`;
            preview.errors.push({line:row.line,key:row.key,message});
            continue;
          }
          if (predecessor.projectId !== issue.projectId) {
            preview.errors.push({ line: row.line, key: row.key, message: `선행 업무 ${predecessor.key}는 같은 프로젝트에 있어야 합니다.` });
            continue;
          }
          targetIds.add(predecessor.id);
          const before = byPair.get(dependencyPair(predecessor.id, issue.id));
          const after = input.type === '-' ? null : {
            id:before?.id ?? randomUUID(),predecessorId:predecessor.id,successorId:issue.id,
            type:input.type ?? before?.type ?? 'FS',lagDays:input.lagDays ?? before?.lagDays ?? 0,
          } as const satisfies Dependency;
          const changed = after ? !before || before.type !== after.type || before.lagDays !== after.lagDays : Boolean(before);
          if (changed) {
            if (before) linkChanges.push({before,after});
            else if (after) linkChanges.push({before:null,after});
            dependencyChanges.push({
              line:row.line,predecessorKey:predecessor.key,predecessorTitle:predecessor.title,successorKey:issue.key,successorTitle:issue.title,
              before:before ? {type:before.type,lagDays:before.lagDays} : null,
              after:after ? {type:after.type,lagDays:after.lagDays} : null,
              ...(projectId === null ? { projectId: issue.projectId } : {}),
            });
            continue;
          }
        }
        if (!datesChanged) preview.unchanged++;
      }
      const projectedLinks = linkChanges.length ? projectScheduleDependencies(dependencies, linkChanges) : dependencies;
      if (linkChanges.some(change => !change.before) && hasScheduleDependencyCycle(projectedLinks)) {
        preview.errors.push({line:null,message:'적용할 선행 업무 연결에 순환 관계가 있습니다. 연결 방향을 확인해 주세요.'});
      }
      preview.errors.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
      if (changes.size || linkChanges.length) {
        const projected = issues.map(issue => {
          const change = changes.get(issue.id);
          return change ? {
            ...issue, startDate: change.startDate, endDate: change.endDate,
            dueDate: change.dueDate === undefined ? issue.dueDate : change.dueDate,
          } : issue;
        });
        preview.warnings = hooks.warnings(projected, affectedLinks(projectedLinks, changes.keys(), linkChanges));
      }
      const keyBindings = keys && [...keys.values()].filter((binding): binding is ScheduleKeyBinding => Boolean(binding && targetIds.has(binding.id)));
      return this.savePreview(preview, state, {
        actorId, issueIds: [...targetIds], changes: [...changes.values()], linkChanges, ...(keyBindings ? { keyBindings } : {}),
      }, hooks);
    });
  }

  private previewBulkDates(raw: unknown, actorId: string, hooks: PasteHooks): SchedulePastePreview {
    const { projectId, issues: selected, changes: requested } = parseBulkDateInput(raw);
    return this.store.transaction(() => {
      if (projectId !== null && !this.store.get('projects', projectId)) throw new SchedulePasteError(404, '프로젝트를 찾을 수 없습니다.');
      this.prune();
      const scope: ScheduleScope = projectId === null ? this.scopeForIssues(selected.map(({ id }) => id)) : { projectId };
      const state = this.scopeState(scope);
      const byId = new Map(state.issues.map(issue => [issue.id, issue]));
      const preview: SchedulePastePreview = {
        ...scope, previewId: null, expiresAt: null, changes: [], warnings: [], errors: [], unchanged: 0,
      };
      const changes = new Map<string, ScheduleDateMutation>();
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
        const dates = proposeDateEdit(issue, requested);
        if (!dates) {
          preview.unchanged++;
          continue;
        }
        const error = hooks.validateChange(issue, dates.change);
        if (error) {
          preview.errors.push({ line: null, issueId: id, key: issue.key, message: error });
          continue;
        }
        changes.set(id, dates.change);
        preview.changes.push(dates.summary);
      }
      if (changes.size) {
        const projected = state.issues.map(issue => {
          const change = changes.get(issue.id);
          return change ? { ...issue, startDate: change.startDate, endDate: change.endDate } : issue;
        });
        preview.warnings = hooks.warnings(projected, affectedLinks(state.dependencies, changes.keys(), []));
      }
      return this.savePreview(preview, state, {
        actorId, issueIds: selected.map(({ id }) => id), changes: [...changes.values()], kind: 'bulk-dates',
      }, hooks);
    });
  }

  private previewRowEdit(raw: unknown, actorId: string, hooks: PasteHooks): SchedulePastePreview {
    const { projectId, issue: selected, changes: requested, linkEdits, rescheduleSuccessors } = parseRowEditInput(raw);
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
      const issueIds = new Set([issue.id]);
      const changes: ScheduleDateMutation[] = [];
      const dates = proposeDateEdit(issue, requested);
      if (dates) {
        const error = hooks.validateChange(issue, dates.change);
        if (error) preview.errors.push({ line: null, issueId: issue.id, key: issue.key, message: error });
        else {
          changes.push(dates.change);
          preview.changes.push(dates.summary);
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
        if (seenPairs.has(proposal.pair)) { linkError(line, duplicate); continue; }
        seenPairs.add(proposal.pair);
        if (!proposal.mutation) continue;
        const { before, after } = proposal.mutation;
        const endpoints = after ?? before!;
        const [predecessor, successor] = endpoints.predecessorId === issue.id ? [issue, related] : [related, issue];
        linkChanges.push(proposal.mutation);
        dependencyChanges.push({
          line: line ?? 1, predecessorKey: predecessor.key, predecessorTitle: predecessor.title, successorKey: successor.key, successorTitle: successor.title,
          before: before && { type: before.type, lagDays: before.lagDays }, after: after && { type: after.type, lagDays: after.lagDays },
        });
      }
      if (!changes.length && !linkChanges.length && !preview.errors.length) preview.unchanged = 1;
      const followUpWarnings: string[] = [];
      if (changes.length || linkChanges.length) {
        const projectedLinks = projectScheduleDependencies(state.dependencies, linkChanges);
        if (linkChanges.some(link => !link.before) && hasScheduleDependencyCycle(projectedLinks)) {
          linkError(null, '적용할 업무 연결에 순환 관계가 있습니다. 연결 방향을 확인해 주세요.');
        }
        if (rescheduleSuccessors && !preview.errors.length) {
          const plan = calculateFixedFollowUpSchedule({
            issues: state.issues, dependencies: projectedLinks, calendar: hooks.calendar(projectId), workflow: hooks.workflow(projectId),
            anchor: dates?.change ?? { id: issue.id, expectedVersion: issue.version, startDate: issue.startDate, endDate: issue.endDate },
          });
          // Include unchanged successors so a new link or changed outside predecessor also invalidates this review.
          for (const id of plan.issueIds) issueIds.add(id);
          for (const message of plan.blocking) preview.errors.push({ line: null, message });
          followUpWarnings.push(...plan.warnings);
          for (const suggestion of plan.changes) {
            if (suggestion.id === issue.id) continue; // The selected row also has its own optional due-date change.
            const successor = issuesById.get(suggestion.id)!;
            const suggestedDates = proposeDateEdit(successor, { startDate: suggestion.toStart, endDate: suggestion.toEnd });
            if (!suggestedDates) continue;
            const error = hooks.validateChange(successor, suggestedDates.change);
            if (error) preview.errors.push({ line: null, issueId: successor.id, key: successor.key, message: error });
            else {
              changes.push(suggestedDates.change);
              preview.changes.push(suggestedDates.summary);
            }
          }
          if (changes.length > 1000 && !preview.errors.length) {
            linkError(null, '한 번에 변경할 수 있는 업무는 1000개입니다. 범위를 나누어 미리 확인해 주세요.');
          }
          for (const { key, toEnd, toDue } of preview.changes) {
            if (toEnd && toDue && toEnd > toDue) followUpWarnings.push(`${key}: 제안한 종료일 ${toEnd}이 목표 마감일 ${toDue}보다 늦습니다.`);
          }
        }
        const changeById = new Map(changes.map(value => [value.id, value]));
        const projectedIssues = state.issues.map(value => {
          const change = changeById.get(value.id);
          return change ? { ...value, startDate: change.startDate, endDate: change.endDate } : value;
        });
        preview.warnings = [...new Set([...followUpWarnings, ...hooks.warnings(projectedIssues, affectedLinks(projectedLinks, changeById.keys(), linkChanges))])];
      }
      return this.savePreview(preview, state, { actorId, issueIds: [...issueIds], changes, linkChanges, kind: 'row-edit',
        ...(followUpWarnings.length ? { followUpWarnings } : {}),
      }, hooks);
    });
  }

  private previewBulkLinks(raw: unknown, actorId: string, hooks: PasteHooks): SchedulePastePreview {
    const { projectId, anchor: selectedAnchor, issues: selected, direction, type, lagDays } = parseBulkLinkInput(raw);
    return this.store.transaction(() => {
      if (!this.store.get('projects', projectId)) throw new SchedulePasteError(404, '프로젝트를 찾을 수 없습니다.');
      this.prune();
      const state = this.projectState(projectId);
      const issuesById = new Map(state.issues.map(issue => [issue.id, issue]));
      const preview: SchedulePastePreview = {
        projectId, previewId: null, expiresAt: null, changes: [], dependencyChanges: [], retainedDependencies: [], warnings: [], errors: [], unchanged: 0,
      };
      const anchor = findPreviewIssue(issuesById, preview.errors, selectedAnchor);
      if (!anchor) return preview;

      const pairs: DependencyAddition[] = [];
      for (const [index, entry] of selected.entries()) {
        const line = index + 1;
        const issue = findPreviewIssue(issuesById, preview.errors, entry, line);
        if (!issue) continue;
        const [predecessor, successor] = direction === 'predecessor' ? [anchor, issue] : [issue, anchor];
        pairs.push({ line, predecessor, successor });
      }
      const { linkChanges, missingDateWarnings, errors, ...review } = prepareLinkAdditions(state, pairs, { type, lagDays }, hooks.warnings);
      return this.savePreview({ ...preview, ...review, errors: [...preview.errors, ...errors] }, state, {
        actorId, issueIds: [anchor.id, ...selected.map(issue => issue.id)], changes: [], linkChanges, kind: 'bulk-links',
        ...(missingDateWarnings.length ? { missingDateWarnings } : {}),
      }, hooks);
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
      const pairs: DependencyAddition[] = [];
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
      const { linkChanges, missingDateWarnings, errors, ...review } = prepareLinkAdditions(state, pairs, { type: 'FS', lagDays: 0 }, hooks.warnings);
      return this.savePreview({
        ...scope, previewId: null, expiresAt: null, changes: [], ...review, errors: [...selectionErrors, ...errors],
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
      if (proposal.keyBindings) {
        const keys = this.workspaceKeys(new Set(proposal.keyBindings.map(({ key }) => key)));
        if (proposal.keyBindings.some(binding => {
          const current = keys.get(binding.key);
          return current?.id !== binding.id || current.projectId !== binding.projectId;
        })) throw new SchedulePasteError(409, '업무 키 또는 업무의 프로젝트가 변경되었습니다. 다시 미리 확인해 주세요.');
      }
      const state = this.scopeState(proposal);
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
        const reviewedIds = new Set(proposal.issueIds);
        if (!trace || trace.issues.length !== reviewedIds.size || trace.issues.some(issue => !reviewedIds.has(issue.id))) {
          throw new SchedulePasteError(409, '상위·하위 업무 구성이 변경되었습니다. 다시 미리 확인해 주세요.');
        }
      }
      if (this.guard(proposal, state, proposal.issueIds, hooks) !== proposal.guard) {
        throw new SchedulePasteError(409, '업무, 연결된 일정 또는 프로젝트 규칙이 변경되었습니다. 다시 미리 확인해 주세요.');
      }
      const { dependencies } = state;
      const linkChanges = proposal.linkChanges ?? [];
      const projectedLinks = linkChanges.length ? projectScheduleDependencies(dependencies, linkChanges) : dependencies;
      if (linkChanges.some(change => !change.before) && hasScheduleDependencyCycle(projectedLinks)) {
        throw new SchedulePasteError(409, '업무 연결이 변경되어 순환 관계가 생깁니다. 다시 미리 확인해 주세요.');
      }
      const links = affectedLinks(projectedLinks, proposal.changes.map(change => change.id), linkChanges);
      const result = hooks.commitChanges(request, proposal.changes, links, linkChanges, {
        projectId: proposal.projectId ?? undefined,
        // The selected row heads the guarded read set even when only successors or links change.
        issueId: proposal.kind === 'row-edit' ? proposal.issueIds[0] : undefined,
      });
      if (proposal.followUpWarnings || proposal.missingDateWarnings) {
        result.warnings = [...new Set([...(proposal.followUpWarnings ?? []), ...(proposal.missingDateWarnings ?? []), ...result.warnings])];
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
      res.json(this.preview(req.body.projectId, req.body.text, hooks.actor(req), hooks));
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
