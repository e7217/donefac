import { randomUUID } from 'node:crypto';
import type { Express, Request } from 'express';
import { z } from 'zod';
import { STATUS, type Project, type ProjectReport, type ReportQuery, type ReportSnapshot, type ReportSnapshotSummary, type RichContent, type StatusCategory, type User } from '../shared/types.js';
import type { ReportingLedger } from './reporting-ledger.js';
import { aggregateProjectReport, parseReportQuery } from './reporting-metrics.js';
import type { Store } from './store.js';

export class ReportingError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const categories = ['backlog', 'todo', 'in_progress', 'review', 'done', 'cancelled'] as const;
const category = z.enum(categories);
const count = z.number().int().nonnegative().safe();
const duration = z.number().finite().nonnegative().nullable();
const timestamp = z.string().datetime({precision:3});
const rangeTimestamp = z.string().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const name = z.string().min(1).max(500);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const state = z.object({
  backlog: count, todo: count, in_progress: count, review: count, done: count, cancelled: count,
}).strict();
const queryShape = z.object({
  projectId: name, startDate: day, endDate: day, timeZone: name,
  issueType: name.nullable(), assigneeId: name.nullable(),
}).strict();
const reportShape = z.object({
  definitionVersion: z.literal(1), query: queryShape, generatedAt: timestamp,
  rangeStartAt: rangeTimestamp, rangeEndAt: rangeTimestamp, observedThrough: timestamp.nullable(),
  coverage: z.array(z.object({
    id: name, startedAt: timestamp, endedAt: timestamp.nullable(), reason: z.enum(['initial', 'restore']),
  }).strict()),
  current: z.object({total: count, state, overdue: count, dueSoon: count}).strict(),
  period: z.object({
    created: count, deleted: count, completedIssues: count, completionTransitions: count,
    repeatedCompletions: count, reopened: count, reclassified: count, medianCycleHours: duration, cycleSamples: count,
  }).strict(),
  days: z.array(z.object({
    date: day, coverage: z.enum(['complete', 'partial', 'unobserved']), state: state.nullable(),
    created: count, completed: count, reopened: count,
  }).strict()).min(1).max(92),
  issues: z.array(z.object({
    issue: z.object({
      issueId: name, projectId: name, key: name, title: name, type: name, statusId: name,
      statusLabel: name, category, assigneeId: name.nullable(), startDate: day.nullable(),
      endDate: day.nullable(), dueDate: day.nullable(),
    }).strict(),
    completed: count, reopened: count, lastCompletedAt: timestamp.nullable(),
    cycleHours: duration, deleted: z.boolean(),
  }).strict()).max(5000),
}).strict();
const titleShape = z.string().trim().min(1).max(200);
const snapshotShape = z.object({
  id: z.string().uuid(), projectId: name, actorId: name, title: titleShape, createdAt: timestamp,
  documentId: z.string().uuid(), report: reportShape,
}).strict();

interface ReportRoutes {
  actor(req: Request): string;
  createDocument(req: Request, snapshot: ReportSnapshot, content: RichContent, issueIds: string[]): void;
}

function stateSummary(state: Record<StatusCategory, number>) {
  return categories.map(key => `${STATUS[key].label} ${state[key]}개`).join(' · ');
}

export class ReportingService {
  constructor(private store: Store, private ledger: ReportingLedger) {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS report_snapshots (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, created_at TEXT NOT NULL, json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS report_snapshots_project_at ON report_snapshots(project_id, created_at DESC, id DESC);
    `);
  }

  all(): ReportSnapshot[] {
    return this.store.all('report_snapshots');
  }

  private insert(snapshot: ReportSnapshot) {
    this.store.db.prepare('INSERT INTO report_snapshots(id,project_id,created_at,json) VALUES(?,?,?,?)')
      .run(snapshot.id, snapshot.projectId, snapshot.createdAt, JSON.stringify(snapshot));
  }

  validateRestore(raw: unknown, exportedAt: string, projects: Project[], users: User[]): ReportSnapshot[] {
    if (!Array.isArray(raw) || raw.length > 100000) throw new ReportingError(400, '백업에 올바른 보고서 보관본 목록이 필요합니다.');
    const projectIds = new Set(projects.map(project => project.id));
    const userIds = new Set(users.map(user => user.id));
    const ids = new Set<string>(), documentIds = new Set<string>();
    return raw.map(value => {
      const parsed = snapshotShape.safeParse(value);
      if (!parsed.success) throw new ReportingError(400, '백업의 보고서 보관본 형식이 올바르지 않습니다.');
      const snapshot: ReportSnapshot = parsed.data, report = snapshot.report;
      const query = parseReportQuery(report.query);
      if (query.projectId !== snapshot.projectId || !projectIds.has(snapshot.projectId) || !userIds.has(snapshot.actorId) ||
          ids.has(snapshot.id) || documentIds.has(snapshot.documentId) || snapshot.createdAt !== report.generatedAt || snapshot.createdAt > exportedAt ||
          Date.parse(report.rangeStartAt) > Date.parse(report.rangeEndAt) || report.observedThrough && report.observedThrough > report.generatedAt ||
          report.issues.some(row => row.issue.projectId !== snapshot.projectId) ||
          report.days[0].date !== query.startDate || report.days.at(-1)?.date !== query.endDate ||
          report.days.some((entry, i) => i > 0 && report.days[i - 1].date >= entry.date)) {
        throw new ReportingError(400, '백업에 중복된 보고서 보관본 또는 잘못된 프로젝트·기간·시각이 있습니다.');
      }
      ids.add(snapshot.id);
      documentIds.add(snapshot.documentId);
      return snapshot;
    });
  }

  replaceRestored(snapshots: ReportSnapshot[]): void {
    this.store.db.exec('DELETE FROM report_snapshots');
    for (const snapshot of snapshots) this.insert(snapshot);
  }

  private capture(query: ReportQuery): ProjectReport {
    if (!this.store.get('projects', query.projectId)) throw new ReportingError(404, '프로젝트를 찾을 수 없습니다.');
    return aggregateProjectReport(query, {
      current: this.ledger.current(query.projectId),
      ledger: this.ledger.read(query.projectId),
      generatedAt: new Date().toISOString(),
    });
  }

  private weeklyContent(snapshot: ReportSnapshot) {
    const {report} = snapshot;
    const {query, current, period} = report;
    const paragraph = (text: string): RichContent => ({type:'paragraph',content:[{type:'text',text}]});
    const heading = (text: string): RichContent => ({type:'heading',attrs:{level:2},content:[{type:'text',text}]});
    const href = `#/${encodeURIComponent(snapshot.projectId)}/reports/${snapshot.id}`;
    const covered = report.days.filter(value => value.coverage === 'complete').length;
    const items = [...report.issues].sort((a, b) => b.completed - a.completed || b.reopened - a.reopened || a.issue.key.localeCompare(b.issue.key)).slice(0, 30);
    const issueIds: string[] = [];
    const content: RichContent[] = [
      paragraph(`${query.startDate} ~ ${query.endDate} · ${query.timeZone}`),
      {type:'paragraph',content:[{type:'text',text:'저장한 보고서 열기',marks:[{type:'link',attrs:{href,target:'_self'}}]}]},
      heading('기간 중 업무 흐름'),
      paragraph(`생성 ${period.created}개 · 완료 업무 ${period.completedIssues}개 · 완료 전이 ${period.completionTransitions}회 · 재개 ${period.reopened}회 · 삭제 ${period.deleted}개`),
      paragraph(`하루 전체를 관측한 날짜 ${covered}/${report.days.length}일 · 일부 또는 전체가 미수집된 날짜는 저장한 보고서에서 확인할 수 있습니다.`),
      heading('작성 시점 업무 현황'),
      paragraph(`${stateSummary(current.state)} · 마감 지연 ${current.overdue}개`),
    ];
    if (items.length) content.push(heading(`관련 업무 ${items.length}/${report.issues.length}개`));
    for (const row of items) {
      const label = `${row.issue.key} ${row.issue.title}`;
      if (!row.deleted && this.store.get('issues', row.issue.issueId)) {
        issueIds.push(row.issue.issueId);
        content.push({type:'issueReference',attrs:{issueId:row.issue.issueId,label:label.slice(0,300)}});
      } else content.push(paragraph(label));
    }
    content.push(heading('회의 메모'), {type:'paragraph'});
    return {content:{type:'doc',content},issueIds};
  }

  registerRoutes(app: Express, hooks: ReportRoutes) {
    const base = '/api/projects/:id';
    app.get(`${base}/report`, (req, res) => {
      res.json(this.capture(parseReportQuery({...req.query,projectId:req.params.id})));
    });
    app.get(`${base}/report-snapshots`, (req, res) => {
      if (!this.store.get('projects',req.params.id)) throw new ReportingError(404, '프로젝트를 찾을 수 없습니다.');
      const rows = this.store.db.prepare(
        'SELECT json FROM report_snapshots WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT 100',
      ).all(req.params.id) as {json:string}[];
      res.json(rows.map(({json}): ReportSnapshotSummary => {
        const {report,...metadata} = JSON.parse(json) as ReportSnapshot;
        return {...metadata,query:report.query};
      }));
    });
    app.get(`${base}/report-snapshots/:snapshotId`, (req, res) => {
      const snapshot = this.store.get<ReportSnapshot>('report_snapshots',req.params.snapshotId);
      if (!snapshot || snapshot.projectId !== req.params.id) throw new ReportingError(404, '저장한 보고서를 찾을 수 없습니다.');
      res.json(snapshot);
    });
    app.post(`${base}/report-snapshots`, (req, res) => {
      const title = titleShape.safeParse(req.body.title);
      if (!title.success) throw new ReportingError(400, '주간 문서 제목을 1~200자로 입력해 주세요.');
      const query = parseReportQuery(req.body.query);
      if (query.projectId !== req.params.id) throw new ReportingError(400, '보고서와 프로젝트가 일치해야 합니다.');
      const snapshot = this.store.transaction(() => {
        const report = this.capture(query);
        const snapshot: ReportSnapshot = {
          id:randomUUID(),projectId:query.projectId,actorId:hooks.actor(req),title:title.data,
          createdAt:report.generatedAt,documentId:randomUUID(),report,
        };
        const {content,issueIds} = this.weeklyContent(snapshot);
        hooks.createDocument(req,snapshot,content,issueIds);
        this.insert(snapshot);
        return snapshot;
      });
      res.status(201).json(snapshot);
    });
  }
}
