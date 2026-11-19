import { createHash, randomUUID } from 'node:crypto';
import type { Express, Request } from 'express';
import type { Dependency, Issue, SchedulePasteApplyResult, SchedulePastePreview } from '../shared/types.js';
import { AUTO_PREVIEW_TTL_MS, AUTO_RESULT_RETENTION_MS, type AutomaticScheduleMutation } from './automatic-schedule.js';
import { parseSchedulePaste } from './schedule-paste-parser.js';
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
  commitChanges(request: Request, changes: AutomaticScheduleMutation[], dependencies: Dependency[]): SchedulePasteApplyResult;
}

interface PasteProposal {
  id: string;
  projectId: string;
  actorId: string;
  removeAfter: string;
  issueIds: string[];
  guard: string;
  changes: AutomaticScheduleMutation[];
  result?: SchedulePasteApplyResult;
}

const table = 'schedule_paste_previews';
const after = (ms: number) => new Date(Date.now() + ms).toISOString();

function incidentLinks(dependencies: Dependency[], issueIds: Iterable<string>) {
  const targets = new Set(issueIds);
  return dependencies.filter(link => targets.has(link.predecessorId) || targets.has(link.successorId));
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
    const linkVersions = links.map(link => [link.id, link.predecessorId, link.successorId, link.type, link.lagDays]);
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
      const preview: SchedulePastePreview = {
        projectId, previewId:null, expiresAt:null, changes:[], warnings:[], errors:parsed.errors, unchanged:0,
      };
      const changes = new Map<string, AutomaticScheduleMutation>();
      const targetIds: string[] = [];
      for (const row of parsed.rows) {
        const issue = byKey.get(row.key);
        if (!issue) {
          const message = issue === null ? '이 프로젝트에 동일한 업무 키가 두 개 이상 있습니다.' : '이 프로젝트에 해당 업무 키가 없습니다.';
          preview.errors.push({line:row.line,key:row.key,message});
          continue;
        }
        const startDate = row.startDate === undefined ? issue.startDate : row.startDate;
        const endDate = row.endDate === undefined ? issue.endDate : row.endDate;
        if (startDate && endDate && startDate > endDate) {
          preview.errors.push({line:row.line,key:row.key,message:'종료일을 시작일 이후로 지정해 주세요.'});
          continue;
        }
        targetIds.push(issue.id);
        if (startDate === issue.startDate && endDate === issue.endDate) {
          preview.unchanged++;
          continue;
        }
        const change = {id:issue.id,expectedVersion:issue.version,startDate,endDate};
        const error = hooks.validateChange(issue, change);
        if (error) {
          preview.errors.push({line:row.line,key:row.key,message:error});
          continue;
        }
        changes.set(issue.id, change);
        preview.changes.push({
          id:issue.id,key:issue.key,title:issue.title,version:issue.version,
          fromStart:issue.startDate,fromEnd:issue.endDate,toStart:startDate,toEnd:endDate,
        });
      }
      preview.errors.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
      if (changes.size > 0) {
        const projected = issues.map(issue => {
          const change = changes.get(issue.id);
          return change ? {...issue,startDate:change.startDate,endDate:change.endDate} : issue;
        });
        preview.warnings = hooks.warnings(projected, incidentLinks(dependencies, changes.keys()));
      }
      if (preview.errors.length || !changes.size) return preview;
      const id = randomUUID();
      const expiresAt = after(AUTO_PREVIEW_TTL_MS);
      const proposal: PasteProposal = {
        id,projectId,actorId,removeAfter:expiresAt,issueIds:targetIds,
        guard:this.guard(issues, dependencies, targetIds, hooks.versions(projectId)),
        changes:[...changes.values()],
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
      const links = incidentLinks(dependencies, proposal.changes.map(change => change.id));
      const result = hooks.commitChanges(request, proposal.changes, links);
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
