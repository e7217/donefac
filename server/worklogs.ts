import { createHash } from 'node:crypto';
import type { Express, Request } from 'express';
import type { Issue, IssueWorklogPage, Project, ProjectWorklogReport, User, WorklogEntry } from '../shared/types.js';
import { calendarDay, isCalendarDate } from '../shared/calendar.js';
import type { Store } from './store.js';

export class WorklogError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
interface WorklogRecord extends WorklogEntry {
  createHash: string;
  deletedAt: string | null;
}
interface Hooks {
  actor(request: Request): string;
  activity(request: Request, resourceType: string, resourceId: string, action: string, detail?: string): void;
}
type Fields = Pick<WorklogEntry, 'workDate' | 'minutes' | 'note'>;

const pageSize = 50;
const maxNoteLength = 2000;
const maxVersion = Number.MAX_SAFE_INTEGER - 1;
const minuteLimit = 1440;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function fail(status: number, message: string): never { throw new WorklogError(status, message); }

function fields(value: Record<string, unknown>): Fields {
  if (!isCalendarDate(value.workDate)) fail(400, '작업 날짜를 YYYY-MM-DD 형식으로 입력해 주세요.');
  if (typeof value.minutes !== 'number' || !Number.isInteger(value.minutes) || value.minutes < 1 || value.minutes > minuteLimit) {
    fail(400, '작업 시간은 1~1,440분 사이의 정수여야 합니다.');
  }
  const note = value.note === undefined ? '' : value.note;
  if (typeof note !== 'string' || note.length > maxNoteLength) fail(400, '작업 메모는 2,000자 이하여야 합니다.');
  return {workDate:value.workDate,minutes:value.minutes,note:note.trim()};
}

function canonicalTime(value: unknown): value is string {
  return typeof value === 'string' && timestamp.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function entry({ id, issueId, projectId, issueKey, issueTitle, authorId, workDate, minutes, note, version, createdAt, updatedAt }: WorklogRecord): WorklogEntry {
  return { id, issueId, projectId, issueKey, issueTitle, authorId, workDate, minutes, note, version, createdAt, updatedAt };
}

export class WorklogService {
  constructor(private store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS worklogs (
        id TEXT PRIMARY KEY, issue_id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id), author_id TEXT NOT NULL REFERENCES users(id),
        work_date TEXT NOT NULL, created_at TEXT NOT NULL, minutes INTEGER NOT NULL,
        deleted_at TEXT, json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS worklogs_issue_page ON worklogs(issue_id,work_date DESC,created_at DESC,id DESC) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS worklogs_project_date ON worklogs(project_id,work_date,author_id) WHERE deleted_at IS NULL;
    `);
  }

  private issue(id: string): Issue {
    return this.store.get<Issue>('issues', id) ?? fail(404, '업무를 찾을 수 없습니다.');
  }

  private write(value: WorklogRecord) {
    this.store.db.prepare(`
      INSERT INTO worklogs(id,issue_id,project_id,author_id,work_date,created_at,minutes,deleted_at,json)
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET work_date=excluded.work_date,minutes=excluded.minutes,
        deleted_at=excluded.deleted_at,json=excluded.json
    `).run(value.id, value.issueId, value.projectId, value.authorId, value.workDate, value.createdAt,
      value.minutes, value.deletedAt, JSON.stringify(value));
  }

  all(): WorklogRecord[] { return this.store.all<WorklogRecord>('worklogs'); }

  private list(issueId: string, offset: unknown): IssueWorklogPage {
    this.issue(issueId);
    if (offset !== undefined && (typeof offset !== 'string' || !/^\d{1,9}$/.test(offset))) {
      fail(400, '작업 시간 목록의 시작 위치를 확인해 주세요.');
    }
    const totals = this.store.db.prepare(`
      SELECT COUNT(*) AS totalEntries,COALESCE(SUM(minutes),0) AS totalMinutes FROM worklogs
      WHERE issue_id=? AND deleted_at IS NULL
    `).get(issueId) as {totalMinutes: number; totalEntries: number};
    const rows = this.store.db.prepare(`
      SELECT json FROM worklogs WHERE issue_id=? AND deleted_at IS NULL
      ORDER BY work_date DESC,created_at DESC,id DESC LIMIT ? OFFSET ?
    `).all(issueId, pageSize, Number(offset ?? 0)) as {json: string}[];
    return {...totals,entries:rows.map(row => entry(JSON.parse(row.json)))};
  }

  private create(request: Request, issueId: string, hooks: Hooks): WorklogEntry {
    const actorId = hooks.actor(request);
    const {requestId} = request.body;
    if (typeof requestId !== 'string' || !uuid.test(requestId)) fail(400, '작업 시간 요청 ID가 필요합니다.');
    const input = fields(request.body);
    const fingerprint = createHash('sha256').update(JSON.stringify([issueId,actorId,input])).digest('hex');
    return this.store.transaction(() => {
      const issue = this.issue(issueId);
      const existing = this.store.get<WorklogRecord>('worklogs', requestId);
      if (existing) {
        if (existing.createHash !== fingerprint || existing.issueId !== issueId || existing.authorId !== actorId || existing.deletedAt !== null) {
          fail(409, '이미 사용한 작업 시간 요청입니다. 현재 기록을 확인해 주세요.');
        }
        return entry(existing);
      }
      const now = new Date().toISOString();
      const value = {
        ...input,id:requestId,issueId,projectId:issue.projectId,issueKey:issue.key,issueTitle:issue.title,
        authorId:actorId,version:1,createdAt:now,updatedAt:now,createHash:fingerprint,deletedAt:null,
      };
      this.write(value);
      hooks.activity(request,'issue',issueId,'작업 시간 등록',`${input.workDate} · ${input.minutes}분`);
      return entry(value);
    });
  }

  private requireOwner(issueId: string, id: string, actorId: string, expectedVersion: unknown) {
    this.issue(issueId);
    const value = this.store.get<WorklogRecord>('worklogs', id);
    if (!value || value.issueId !== issueId) fail(404, '작업 시간 기록을 찾을 수 없습니다.');
    if (value.authorId !== actorId) fail(403, '작성자만 작업 시간 기록을 수정하거나 삭제할 수 있습니다.');
    if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 1) fail(400, '기록의 편집 버전이 필요합니다.');
    return value;
  }

  private edit(request: Request, issueId: string, id: string, hooks: Hooks): WorklogEntry {
    const actorId = hooks.actor(request);
    const input = fields(request.body);
    return this.store.transaction(() => {
      const old = this.requireOwner(issueId, id, actorId, request.body.expectedVersion);
      if (old.deletedAt !== null) fail(404, '삭제된 작업 시간 기록입니다.');
      if (old.version !== request.body.expectedVersion || old.version >= maxVersion) {
        fail(409, '작업 시간 기록이 변경되었습니다. 최신 기록을 확인해 주세요.');
      }
      if (old.workDate === input.workDate && old.minutes === input.minutes && old.note === input.note) return entry(old);
      const updated = {...old,...input,version:old.version+1,updatedAt:new Date().toISOString()};
      this.write(updated);
      hooks.activity(request,'issue',issueId,'작업 시간 수정',`${old.workDate} ${old.minutes}분 → ${updated.workDate} ${updated.minutes}분`);
      return entry(updated);
    });
  }

  private remove(request: Request, issueId: string, id: string, hooks: Hooks) {
    const actorId = hooks.actor(request);
    return this.store.transaction(() => {
      const old = this.requireOwner(issueId, id, actorId, request.body.expectedVersion);
      if (old.deletedAt !== null) {
        if (old.version === request.body.expectedVersion+1) return {ok:true};
        fail(404, '삭제된 작업 시간 기록입니다.');
      }
      if (old.version !== request.body.expectedVersion || old.version >= maxVersion) {
        fail(409, '작업 시간 기록이 변경되었습니다. 최신 기록을 확인해 주세요.');
      }
      const now = new Date().toISOString();
      this.write({...old,note:'',version:old.version+1,updatedAt:now,deletedAt:now});
      hooks.activity(request,'issue',issueId,'작업 시간 삭제',`${old.workDate} · ${old.minutes}분`);
      return {ok:true};
    });
  }

  private report(projectId: string, query: Request['query']): ProjectWorklogReport {
    if (!this.store.get('projects', projectId)) fail(404,'프로젝트를 찾을 수 없습니다.');
    const {startDate,endDate} = query;
    if (!isCalendarDate(startDate) || !isCalendarDate(endDate)) fail(400,'시작일과 종료일을 YYYY-MM-DD로 지정해 주세요.');
    const start = calendarDay(startDate), end = calendarDay(endDate);
    if (end < start || end-start >= 92) fail(400,'작업 시간 조회 기간은 1~92일이어야 합니다.');
    const authorId = query.authorId === undefined || query.authorId === '' ? null : query.authorId;
    if (authorId !== null && (typeof authorId !== 'string' || !this.store.get('users', authorId))) {
      fail(400,'작업 시간 작성자를 확인해 주세요.');
    }
    const condition = `project_id=? AND work_date BETWEEN ? AND ? AND deleted_at IS NULL${authorId === null ? '' : ' AND author_id=?'}`;
    const params = authorId === null ? [projectId,startDate,endDate] : [projectId,startDate,endDate,authorId];
    const metric = 'SUM(minutes) AS minutes, COUNT(*) AS entries';
    const days = this.store.db.prepare(`
      SELECT work_date AS date,${metric} FROM worklogs WHERE ${condition} GROUP BY work_date
    `).all(...params) as ProjectWorklogReport['days'];
    const byAuthor = this.store.db.prepare(`
      SELECT author_id AS authorId,${metric} FROM worklogs WHERE ${condition}
      GROUP BY author_id ORDER BY minutes DESC,author_id
    `).all(...params) as ProjectWorklogReport['byAuthor'];
    const totalsByIssue = this.store.db.prepare(`
      WITH grouped AS (
        SELECT issue_id AS issueId, json,
          SUM(minutes) OVER (PARTITION BY issue_id) AS minutes,
          COUNT(*) OVER (PARTITION BY issue_id) AS entries,
          ROW_NUMBER() OVER (PARTITION BY issue_id ORDER BY work_date DESC,created_at DESC,id DESC) AS position
        FROM worklogs WHERE ${condition}
      )
      SELECT g.issueId,g.minutes,g.entries,
        COALESCE(json_extract(i.json,'$.key'),json_extract(g.json,'$.issueKey')) AS key,
        COALESCE(json_extract(i.json,'$.title'),json_extract(g.json,'$.issueTitle')) AS title,
        i.id IS NULL AS deleted
      FROM grouped g LEFT JOIN issues i ON i.id=g.issueId WHERE g.position=1
      ORDER BY g.minutes DESC,g.issueId
    `).all(...params) as (Omit<ProjectWorklogReport['byIssue'][number], 'deleted'> & {deleted: number})[];
    const byIssue = totalsByIssue.map(row => ({...row,deleted:Boolean(row.deleted)}));
    const observed = new Map(days.map(day => [day.date,day]));
    const counts = Array.from({length:end-start+1},(_,index) => {
      const date = new Date((start+index)*86_400_000).toISOString().slice(0,10);
      return observed.get(date) ?? {date,minutes:0,entries:0};
    });
    return {
      projectId,startDate,endDate,authorId,
      minutes:days.reduce((total,day) => total+day.minutes,0),
      entryCount:days.reduce((total,day) => total+day.entries,0),
      byAuthor,byIssue,days:counts,
    };
  }

  validateRestore(raw: unknown, projects: Project[], issues: Issue[], users: User[], exportedAt: string): WorklogRecord[] {
    if (!Array.isArray(raw)) fail(400,'백업의 작업 시간 기록 목록이 필요합니다.');
    const projectIds = new Set(projects.map(project => project.id));
    const userIds = new Set(users.map(user => user.id));
    const issueProjects = new Map(issues.map(issue => [issue.id,issue.projectId]));
    const ids = new Set<string>();
    return raw.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400,'작업 시간 기록을 확인해 주세요.');
      const {id,issueId,projectId,issueKey,issueTitle,authorId,version,createdAt,updatedAt,createHash,deletedAt} = value as WorklogRecord;
      const exists = typeof issueId === 'string' && issueProjects.has(issueId);
      if (typeof id !== 'string' || !uuid.test(id) || ids.has(id) || typeof issueId !== 'string' || !issueId ||
          !projectIds.has(projectId) || !userIds.has(authorId) || exists && issueProjects.get(issueId) !== projectId ||
          typeof issueKey !== 'string' || !issueKey || issueKey.length > 200 ||
          typeof issueTitle !== 'string' || !issueTitle || issueTitle.length > 300 ||
          !Number.isSafeInteger(version) || version < 1 || version >= maxVersion ||
          !canonicalTime(createdAt) || !canonicalTime(updatedAt) || createdAt > updatedAt || updatedAt > exportedAt ||
          typeof createHash !== 'string' || !/^[a-f0-9]{64}$/.test(createHash) ||
          deletedAt !== null && (!canonicalTime(deletedAt) || deletedAt !== updatedAt || version < 2) ||
          typeof value.note !== 'string' || deletedAt !== null && value.note !== '') {
        fail(400,'백업의 작업 시간 기록에 잘못된 ID·작성자·업무·버전·시각이 있습니다.');
      }
      ids.add(id);
      return {...fields(value),id,issueId,projectId,issueKey,issueTitle,authorId,version,createdAt,updatedAt,createHash,deletedAt};
    });
  }

  clearForRestore(): Map<string, number> {
    const old = new Map(this.all().map(value => [value.id,value.version]));
    this.store.db.exec('DELETE FROM worklogs');
    return old;
  }

  replaceRestored(data: WorklogRecord[], previous: Map<string, number>) {
    for (const value of data) this.write({...value,version:Math.max(value.version,(previous.get(value.id) ?? 0)+1)});
  }

  registerRoutes(app: Express, hooks: Hooks) {
    const issue = '/api/issues/:id/worklogs';
    app.get(issue, (req,res) => res.json(this.store.transaction(() => this.list(req.params.id,req.query.offset))));
    app.post(issue, (req,res) => res.status(201).json(this.create(req,req.params.id,hooks)));
    app.patch(`${issue}/:entryId`, (req,res) => res.json(this.edit(req,req.params.id,req.params.entryId,hooks)));
    app.delete(`${issue}/:entryId`, (req,res) => res.json(this.remove(req,req.params.id,req.params.entryId,hooks)));
    app.get('/api/projects/:id/worklog-report', (req,res) => res.json(this.store.transaction(() => this.report(req.params.id,req.query))));
  }
}
