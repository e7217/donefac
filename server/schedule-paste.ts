import { createHash, randomUUID } from 'node:crypto';
import type { Express, Request } from 'express';
import type { Dependency, Issue, SchedulePasteApplyResult, SchedulePasteDependencyChange, SchedulePastePreview } from '../shared/types.js';
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

interface PasteHooks {
  actor(request: Request): string;
  versions(projectId: string): ScheduleVersions;
  validateChange(issue: Issue, change: AutomaticScheduleMutation): string | null;
  warnings(issues: Issue[], dependencies: Dependency[]): string[];
  commitChanges(request: Request, changes: AutomaticScheduleMutation[], dependencies: Dependency[], linkChanges: ScheduleDependencyMutation[]): SchedulePasteApplyResult;
}

interface PasteProposal {
  id: string;
  projectId: string;
  actorId: string;
  removeAfter: string;
  issueIds: string[];
  guard: string;
  changes: AutomaticScheduleMutation[];
  linkChanges?: ScheduleDependencyMutation[];
  result?: SchedulePasteApplyResult;
}

const table = 'schedule_paste_previews';
const after = (ms: number) => new Date(Date.now() + ms).toISOString();

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

  private preview(projectId: unknown, raw: unknown, actorId: string, hooks: PasteHooks): SchedulePastePreview {
    if (typeof projectId !== 'string' || !projectId || projectId.length > 200) {
      throw new SchedulePasteError(400, '붙여넣을 프로젝트를 선택해 주세요.');
    }
    const parsed = parseSchedulePaste(raw);
    return this.store.transaction(() => {
      if (!this.store.get('projects', projectId)) throw new SchedulePasteError(404, '프로젝트를 찾을 수 없습니다.');
      this.prune();
      const {issues, dependencies} = this.projectState(projectId);
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
      if (preview.errors.length || (!changes.size && !linkChanges.length)) return preview;
      const id = randomUUID();
      const expiresAt = after(AUTO_PREVIEW_TTL_MS);
      const issueIds = [...targetIds];
      const proposal: PasteProposal = {
        id,projectId,actorId,removeAfter:expiresAt,issueIds,
        guard:this.guard(issues, dependencies, issueIds, hooks.versions(projectId)),
        changes:[...changes.values()],linkChanges,
      };
      this.store.put(table, proposal);
      return {...preview,previewId:id,expiresAt};
    });
  }

  private apply(request: Request, previewId: unknown, hooks: PasteHooks): SchedulePasteApplyResult {
    if (typeof previewId !== 'string' || !previewId || previewId.length > 200) {
      throw new SchedulePasteError(400, '적용할 미리보기 ID가 필요합니다.');
    }
    const actorId = hooks.actor(request);
    return this.store.transaction(() => {
      const proposal = this.store.get<PasteProposal>(table, previewId);
      if (!proposal) throw new SchedulePasteError(404, '미리보기가 없거나 만료되었습니다.');
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
  }
}
