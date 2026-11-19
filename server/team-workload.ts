import type { Express, Request } from 'express';
import {
  calculateTeamWorkload, MAX_TEAM_WORKLOAD_ISSUES, MAX_TEAM_WORKLOAD_PROJECTS, validateWorkloadRange,
  WorkloadError, type WorkloadIssue,
} from '../shared/project-workload.js';
import type { CalendarService } from './calendars.js';
import type { Store } from './store.js';
import type { TeamWorkloadCapacityService } from './team-workload-capacity.js';
import type { WorkflowService } from './workflows.js';

function projectSelection(store: Store, value: unknown): string[] {
  const supplied: unknown[] | undefined = value === undefined ? undefined : Array.isArray(value) ? value : [value];
  if (supplied && !supplied.every((id): id is string => typeof id === 'string' && id.length > 0)) {
    throw new WorkloadError(400, '작업량 조회 프로젝트를 확인해 주세요.');
  }
  const projectIds = supplied ?? (store.db.prepare('SELECT id FROM projects ORDER BY rowid LIMIT ?')
    .all(MAX_TEAM_WORKLOAD_PROJECTS + 1) as { id: string }[]).map(row => row.id);
  if (projectIds.length > MAX_TEAM_WORKLOAD_PROJECTS || new Set(projectIds).size !== projectIds.length) {
    throw new WorkloadError(400, `작업량 조회 프로젝트는 중복 없이 최대 ${MAX_TEAM_WORKLOAD_PROJECTS}개를 선택해 주세요.`);
  }
  return projectIds;
}

export function registerTeamWorkloadRoutes(app: Express, {
  store, capacity, calendars, workflows, actor, activity,
}: {
  store: Store;
  capacity: TeamWorkloadCapacityService;
  calendars: CalendarService;
  workflows: WorkflowService;
  actor: (req: Request) => string;
  activity: (req: Request, resourceType: string, resourceId: string, action: string, detail?: string) => void;
}) {
  app.get('/api/workload-capacity', (req, res) => {
    if (Object.keys(req.query).length) throw new WorkloadError(400, '팀 가용 시간 조회 조건을 확인해 주세요.');
    res.set('Cache-Control', 'no-store').json(capacity.get());
  });
  app.patch('/api/workload-capacity', (req, res) => {
    actor(req);
    if (Object.keys(req.query).length) throw new WorkloadError(400, '팀 가용 시간 저장 조건을 확인해 주세요.');
    const saved = capacity.save(req.body, value => activity(req, 'workspace', 'team', '팀 가용 시간 변경', `버전 ${value.version}`));
    res.set('Cache-Control', 'no-store').json(saved);
  });
  app.get('/api/workload', (req, res) => {
    if (Object.keys(req.query).some(key => key !== 'startDate' && key !== 'endDate' && key !== 'projectId')) {
      throw new WorkloadError(400, '팀 작업량 조회 조건을 확인해 주세요.');
    }
    const { startDate, endDate } = validateWorkloadRange(req.query.startDate, req.query.endDate);
    const projectIds = projectSelection(store, req.query.projectId);
    const issueRows = store.db.prepare(`
      SELECT id, project_id AS projectId, assignee_id AS assigneeId, json_extract(json, '$.status') AS status,
        json_extract(json, '$.startDate') AS startDate, json_extract(json, '$.endDate') AS endDate,
        json_extract(json, '$.plannedEffortMinutes') AS plannedEffortMinutes
      FROM issues WHERE project_id=?
        AND (startDate IS NULL OR startDate<=?) AND (endDate IS NULL OR endDate>=?)
        AND status NOT IN (SELECT value FROM json_each(?))
      ORDER BY rowid LIMIT ?
    `);
    let remaining = MAX_TEAM_WORKLOAD_ISSUES;
    const projects = projectIds.map(projectId => {
      const calendar = calendars.get(projectId);
      const terminalStatusIds = workflows.get(projectId).statuses.filter(status => status.category === 'done' || status.category === 'cancelled').map(status => status.id);
      const issues = issueRows.all(projectId, endDate, startDate, JSON.stringify(terminalStatusIds), remaining + 1) as unknown as WorkloadIssue[];
      remaining -= issues.length;
      if (remaining < 0) {
        throw new WorkloadError(422, `작업량 조회는 최대 ${MAX_TEAM_WORKLOAD_ISSUES.toLocaleString('ko-KR')}개 업무를 처리합니다. 조회 기간이나 프로젝트를 줄여 주세요.`);
      }
      return { calendar, terminalStatusIds, issues };
    });
    const userIds = (store.db.prepare('SELECT id FROM users ORDER BY rowid').all() as {id: string}[]).map(row => row.id);
    const result = calculateTeamWorkload({ startDate, endDate, userIds, capacity: capacity.get(), projects });
    res.set('Cache-Control', 'no-store').json(result);
  });
}
