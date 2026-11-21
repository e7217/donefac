import { createHash, randomUUID } from 'node:crypto';
import type { Express, Request } from 'express';
import { isCalendarDate } from '../shared/calendar.js';
import { MAX_SCHEDULE_BULK_DATE_ISSUES, type Dependency, type Issue, type ScheduleBulkDateChanges, type ScheduleBulkDateInput,
  type SchedulePasteApplyResult, type SchedulePasteDependencyChange, type SchedulePastePreview } from '../shared/types.js';
import { dependencyGuardFields } from '../shared/schedule-dependencies.js';
import { AUTO_PREVIEW_TTL_MS, AUTO_RESULT_RETENTION_MS, type AutomaticScheduleMutation } from './automatic-schedule.js';
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
  validateChange(issue: Issue, change: ScheduleDateMutation): string | null;
  warnings(issues: Issue[], dependencies: Dependency[]): string[];
  commitChanges(request: Request, changes: ScheduleDateMutation[], dependencies: Dependency[], linkChanges: ScheduleDependencyMutation[]): SchedulePasteApplyResult;
}

interface PasteProposal {
  id: string;
  projectId: string;
  actorId: string;
  removeAfter: string;
  issueIds: string[];
  guard: string;
  changes: ScheduleDateMutation[];
  linkChanges?: ScheduleDependencyMutation[];
  kind?: 'bulk-dates';
  result?: SchedulePasteApplyResult;
}

const table = 'schedule_paste_previews';
const after = (ms: number) => new Date(Date.now() + ms).toISOString();
const dateFields = { startDate: '시작일', endDate: '종료일', dueDate: '목표 마감일' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 200;
}

function parseBulkDateInput(raw: unknown): ScheduleBulkDateInput {
  if (!isRecord(raw) || Object.keys(raw).length !== 3 || !isId(raw.projectId)) {
    throw new SchedulePasteError(400, '프로젝트와 일정 일괄 변경 항목을 확인해 주세요.');
  }
  if (!Array.isArray(raw.issues) || !raw.issues.length || raw.issues.length > MAX_SCHEDULE_BULK_DATE_ISSUES) {
    throw new SchedulePasteError(400, `한 프로젝트에서 업무를 1~${MAX_SCHEDULE_BULK_DATE_ISSUES}개 선택해 주세요.`);
  }
  const ids = new Set<string>();
  const issues = raw.issues.map((entry: unknown) => {
    if (!isRecord(entry) || Object.keys(entry).length !== 2 || !isId(entry.id) ||
        typeof entry.expectedVersion !== 'number' || !Number.isSafeInteger(entry.expectedVersion) || entry.expectedVersion < 1) {
      throw new SchedulePasteError(400, '선택한 업무 ID와 조회 당시 버전을 확인해 주세요.');
    }
    if (ids.has(entry.id)) throw new SchedulePasteError(400, '같은 업무를 두 번 선택할 수 없습니다.');
    ids.add(entry.id);
    return { id: entry.id, expectedVersion: entry.expectedVersion };
  });
  const changes: ScheduleBulkDateChanges = {};
  if (!isRecord(raw.changes) || !Object.keys(raw.changes).length) {
    throw new SchedulePasteError(400, '변경할 날짜 항목을 하나 이상 선택해 주세요.');
  }
  for (const [key, value] of Object.entries(raw.changes)) {
    if (!Object.hasOwn(dateFields, key)) throw new SchedulePasteError(400, '변경할 날짜 항목을 확인해 주세요.');
    const field = key as keyof ScheduleBulkDateChanges;
    if (value !== null && !isCalendarDate(value)) {
      throw new SchedulePasteError(400, `${dateFields[field]}은 YYYY-MM-DD 형식으로 입력해 주세요.`);
    }
    changes[field] = value;
  }
  return { projectId: raw.projectId, issues, changes };
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

  private projectState(projectId: string) {
    const issueRows = this.store.db.prepare('SELECT json FROM issues WHERE project_id=?').all(projectId) as {json: string}[];
    const dependencyRows = this.store.db.prepare(
      'SELECT d.json FROM dependencies d JOIN issues i ON d.predecessor_id=i.id WHERE i.project_id=? ORDER BY d.id',
    ).all(projectId) as {json: string}[];
    return {
      issues: issueRows.map(row => JSON.parse(row.json) as Issue),
      dependencies: dependencyRows.map(row => JSON.parse(row.json) as Dependency),
    };
  }

  private guard(issues: Issue[], dependencies: Dependency[], targetIds: string[], versions: ScheduleVersions) {
    const links = incidentLinks(dependencies, targetIds);
    const related = new Set([...targetIds, ...links.flatMap(link => [link.predecessorId, link.successorId])]);
    const issueVersions = issues.filter(issue => related.has(issue.id)).sort((a, b) => a.id.localeCompare(b.id))
      .map(issue => [issue.id, issue.version]);
    const linkVersions = links.map(dependencyGuardFields);
    return createHash('sha256').update(JSON.stringify({issueVersions, linkVersions, versions})).digest('hex');
  }

  private savePreview(preview: SchedulePastePreview, state: ReturnType<SchedulePasteService['projectState']>,
    proposal: Pick<PasteProposal, 'actorId' | 'issueIds' | 'changes' | 'linkChanges' | 'kind'>, hooks: PasteHooks): SchedulePastePreview {
    if (preview.errors.length || (!proposal.changes.length && !proposal.linkChanges?.length)) return preview;
    const id = randomUUID();
    const expiresAt = after(AUTO_PREVIEW_TTL_MS);
    this.store.put(table, {
      ...proposal, id, projectId: preview.projectId, removeAfter: expiresAt,
      guard: this.guard(state.issues, state.dependencies, proposal.issueIds, hooks.versions(preview.projectId)),
    } satisfies PasteProposal);
    return { ...preview, previewId: id, expiresAt };
  }

  private preview(projectId: unknown, raw: unknown, actorId: string, hooks: PasteHooks): SchedulePastePreview {
    if (typeof projectId !== 'string' || !projectId || projectId.length > 200) {
      throw new SchedulePasteError(400, '붙여넣을 프로젝트를 선택해 주세요.');
    }
    const parsed = parseSchedulePaste(raw);
    return this.store.transaction(() => {
      if (!this.store.get('projects', projectId)) throw new SchedulePasteError(404, '프로젝트를 찾을 수 없습니다.');
      this.prune();
      const state = this.projectState(projectId);
      const {issues, dependencies} = state;
      const byKey = new Map<string, Issue | null>();
      for (const issue of issues) {
        const key = issue.key.toUpperCase();
        byKey.set(key, byKey.has(key) ? null : issue);
      }
      const dependencyChanges: SchedulePasteDependencyChange[] = [];
      const preview: SchedulePastePreview = {
        projectId, previewId:null, expiresAt:null, changes:[], dependencyChanges, warnings:[], errors:parsed.errors, unchanged:0,
      };
      const changes = new Map<string, AutomaticScheduleMutation>();
      const linkChanges: ScheduleDependencyMutation[] = [];
      const byPair = new Map(dependencies.map(link => [dependencyPair(link.predecessorId, link.successorId), link]));
      const targetIds = new Set<string>();
      const resolvedRows: { row: SchedulePasteRow; issue: Issue; datesChanged: boolean }[] = [];
      const requestedDates = new Map<string, { issue: Issue; line: number; change: AutomaticScheduleMutation }>();
      for (const row of parsed.rows) {
        const issue = byKey.get(row.key);
        if (!issue) {
          const message = issue === null ? '이 프로젝트에 동일한 업무 키가 두 개 이상 있습니다.' : '이 프로젝트에 해당 업무 키가 없습니다.';
          preview.errors.push({line:row.line,key:row.key,message});
          continue;
        }
        const datesChanged = (row.startDate !== undefined && row.startDate !== issue.startDate) ||
          (row.endDate !== undefined && row.endDate !== issue.endDate);
        resolvedRows.push({ row, issue, datesChanged });
        if (!datesChanged) continue;
        const previous = requestedDates.get(issue.id);
        const dates = previous ? previous.change : issue;
        requestedDates.set(issue.id, {
          issue, line:previous?.line ?? row.line,
          change:{ id:issue.id,expectedVersion:issue.version,
            startDate:row.startDate === undefined ? dates.startDate : row.startDate,
            endDate:row.endDate === undefined ? dates.endDate : row.endDate },
        });
      }

      const invalidDates = new Set<string>();
      for (const { issue, line, change } of requestedDates.values()) {
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
        preview.changes.push({
          id:issue.id,key:issue.key,title:issue.title,version:issue.version,
          fromStart:issue.startDate,fromEnd:issue.endDate,toStart:startDate,toEnd:endDate,
        });
      }

      for (const { row, issue, datesChanged } of resolvedRows) {
        if (invalidDates.has(issue.id)) continue;
        targetIds.add(issue.id);
        const input = row.dependency;
        if (input) {
          const predecessor = byKey.get(input.predecessorKey);
          if (!predecessor || predecessor.id === issue.id) {
            const message = predecessor === null ? `선행 업무 키 ${input.predecessorKey}가 이 프로젝트에 중복되어 있습니다.`
              : predecessor ? '자기 자신에게 의존할 수 없습니다.' : `이 프로젝트에 선행 업무 키 ${input.predecessorKey}가 없습니다.`;
            preview.errors.push({line:row.line,key:row.key,message});
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
          return change ? {...issue,startDate:change.startDate,endDate:change.endDate} : issue;
        });
        preview.warnings = hooks.warnings(projected, affectedLinks(projectedLinks, changes.keys(), linkChanges));
      }
      return this.savePreview(preview, state, { actorId, issueIds: [...targetIds], changes: [...changes.values()], linkChanges }, hooks);
    });
  }

  private previewBulkDates(raw: unknown, actorId: string, hooks: PasteHooks): SchedulePastePreview {
    const { projectId, issues: selected, changes: requested } = parseBulkDateInput(raw);
    return this.store.transaction(() => {
      if (!this.store.get('projects', projectId)) throw new SchedulePasteError(404, '프로젝트를 찾을 수 없습니다.');
      this.prune();
      const state = this.projectState(projectId);
      const byId = new Map(state.issues.map(issue => [issue.id, issue]));
      const preview: SchedulePastePreview = {
        projectId, previewId: null, expiresAt: null, changes: [], warnings: [], errors: [], unchanged: 0,
      };
      const changes = new Map<string, ScheduleDateMutation>();
      for (const { id, expectedVersion } of selected) {
        const issue = byId.get(id);
        if (!issue) {
          preview.errors.push({ line: null, issueId: id, message: '선택한 업무가 삭제되었거나 현재 프로젝트에 없습니다. 업무를 다시 선택해 주세요.' });
          continue;
        }
        if (issue.version !== expectedVersion) {
          preview.errors.push({ line: null, issueId: id, key: issue.key, message: '업무가 변경되었습니다. 최신 업무를 불러온 뒤 다시 미리 확인해 주세요.' });
          continue;
        }
        const startDate = requested.startDate === undefined ? issue.startDate : requested.startDate;
        const endDate = requested.endDate === undefined ? issue.endDate : requested.endDate;
        const fromDue = issue.dueDate ?? null;
        const toDue = requested.dueDate === undefined ? fromDue : requested.dueDate;
        if (startDate === issue.startDate && endDate === issue.endDate && toDue === fromDue) {
          preview.unchanged++;
          continue;
        }
        const change: ScheduleDateMutation = { id, expectedVersion, startDate, endDate,
          ...(fromDue !== toDue ? { dueDate: toDue } : {}) };
        const error = hooks.validateChange(issue, change);
        if (error) {
          preview.errors.push({ line: null, issueId: id, key: issue.key, message: error });
          continue;
        }
        changes.set(id, change);
        preview.changes.push({ id, key: issue.key, title: issue.title, version: issue.version,
          fromStart: issue.startDate, fromEnd: issue.endDate, fromDue, toStart: startDate, toEnd: endDate, toDue });
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

  private apply(request: Request, previewId: unknown, hooks: PasteHooks, kind?: 'bulk-dates'): SchedulePasteApplyResult {
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
      const {issues, dependencies} = this.projectState(proposal.projectId);
      if (this.guard(issues, dependencies, proposal.issueIds, hooks.versions(proposal.projectId)) !== proposal.guard) {
        throw new SchedulePasteError(409, '업무, 연결된 일정 또는 프로젝트 규칙이 변경되었습니다. 다시 미리 확인해 주세요.');
      }
      const linkChanges = proposal.linkChanges ?? [];
      const projectedLinks = linkChanges.length ? projectScheduleDependencies(dependencies, linkChanges) : dependencies;
      if (linkChanges.some(change => !change.before) && hasScheduleDependencyCycle(projectedLinks)) {
        throw new SchedulePasteError(409, '업무 연결이 변경되어 순환 관계가 생깁니다. 다시 미리 확인해 주세요.');
      }
      const links = affectedLinks(projectedLinks, proposal.changes.map(change => change.id), linkChanges);
      const result = hooks.commitChanges(request, proposal.changes, links, linkChanges);
      this.store.put(table, {...proposal,removeAfter:after(AUTO_RESULT_RETENTION_MS),result});
      return result;
    });
  }

  registerRoutes(app: Express, hooks: PasteHooks) {
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
  }
}
