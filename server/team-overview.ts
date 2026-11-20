import type { Express } from 'express';
import { calendarDate, calendarDay, isCalendarDate, MIN_CALENDAR_DATE } from '../shared/calendar.js';
import { DEFAULT_RESERVATION_TIME_ZONE, reservationDayRange, reservationLocalDateTime } from '../shared/time-reservations.js';
import { issueDeadline, myWorkMembership } from '../shared/my-work.js';
import {
  isTeamOverviewIssueMetric, PRIORITY, TEAM_OVERVIEW_ISSUE_METRICS, type Issue, type Priority, type TeamOverviewCounts,
  type TeamOverviewDeadline, type TeamOverviewGitlabActivity, type TeamOverviewIssueMetric, type TeamOverviewIssueQueueItem,
  type TeamOverviewPage, type TeamOverviewProject, type TeamOverviewResult, type WorkspaceSnapshot,
} from '../shared/types.js';
import { projectWorkflow, statusMeta } from '../shared/workflow-helpers.js';
import { listPendingTeamReviews } from './document-publication-list.js';
import type { Store } from './store.js';
import type { TimeReservationService } from './time-reservations.js';

const PAGE_SIZE = 10;
const MAX_OFFSET = 1_000_000;
const PAGE_PARAMETERS = ['deadlineOffset', 'reviewOffset', 'gitlabOffset', 'reservationOffset', 'issueOffset'] as const;
const QUERY_PARAMETERS = new Set<string>(['projectId', 'memberId', 'date', 'issueMetric', ...PAGE_PARAMETERS]);
const priorityOrder = Object.keys(PRIORITY) as Priority[];
const issueKeys = new Intl.Collator('ko', { numeric: true });
const timestampFormat = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

type OverviewData = Pick<WorkspaceSnapshot, 'projects' | 'issues' | 'workflows' | 'gitlabLinks'>;
type Dependencies = { store: Store; snapshot: () => OverviewData; timeReservations: TimeReservationService };
type Selection = {
  projectId: string | null;
  memberId: string | null;
  date: string;
  dayRange: { startAt: string; endAt: string };
  deadlineOffset: number;
  reviewOffset: number;
  gitlabOffset: number;
  reservationOffset: number;
  issueMetric?: TeamOverviewIssueMetric;
  issueOffset: number;
};

class TeamOverviewError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function identifier(value: unknown, label: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TeamOverviewError(400, `${label}을(를) 확인해 주세요.`);
  }
  return value;
}

function offset(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== 'string' || !/^\d{1,7}$/.test(value) || Number(value) > MAX_OFFSET) {
    throw new TeamOverviewError(400, '조회 시작 위치는 0~1,000,000 사이의 정수여야 합니다.');
  }
  return Number(value);
}

function readSelection(query: Record<string, unknown>): Selection {
  if (Object.keys(query).some(key => !QUERY_PARAMETERS.has(key))) {
    throw new TeamOverviewError(400, '팀 개요 조회 조건을 확인해 주세요.');
  }
  const date = query.date === undefined ? reservationLocalDateTime(new Date().toISOString()).slice(0, 10) : query.date;
  if (!isCalendarDate(date)) throw new TeamOverviewError(400, '기준 날짜는 유효한 YYYY-MM-DD 형식이어야 합니다.');
  const dayRange = reservationDayRange(date);
  if (!dayRange) throw new TeamOverviewError(400, '서울 시간에서 조회할 수 있는 기준 날짜를 선택해 주세요.');
  const issueMetric = query.issueMetric;
  if ((issueMetric !== undefined && !isTeamOverviewIssueMetric(issueMetric)) ||
    (issueMetric === undefined && query.issueOffset !== undefined)) {
    throw new TeamOverviewError(400, '업무 현황 조건을 확인해 주세요.');
  }
  return {
    projectId: identifier(query.projectId, '프로젝트 ID'), memberId: identifier(query.memberId, '팀원 ID'), date, dayRange,
    deadlineOffset: offset(query.deadlineOffset), reviewOffset: offset(query.reviewOffset),
    gitlabOffset: offset(query.gitlabOffset), reservationOffset: offset(query.reservationOffset),
    issueMetric, issueOffset: offset(query.issueOffset),
  };
}

function page<T>(items: T[], start: number): TeamOverviewPage<T> {
  return { total: items.length, offset: start, limit: PAGE_SIZE, items: items.slice(start, start + PAGE_SIZE) };
}

function emptyCounts(): TeamOverviewCounts {
  return { open: 0, overdue: 0, dueSoon: 0, unscheduled: 0, unassigned: 0 };
}

type RankedIssue<T> = { issue: T; priority: Priority };
type RankedIssueIdentity = Pick<TeamOverviewIssueQueueItem, 'id' | 'key' | 'deadline'>;
function compareRankedIssues(a: RankedIssue<RankedIssueIdentity>, b: RankedIssue<RankedIssueIdentity>): number {
  const aDeadline = a.issue.deadline;
  const bDeadline = b.issue.deadline;
  const dateOrder = aDeadline === null ? Number(bDeadline !== null)
    : bDeadline === null ? -1 : aDeadline.localeCompare(bDeadline);
  return dateOrder || priorityOrder.indexOf(a.priority) - priorityOrder.indexOf(b.priority) ||
    issueKeys.compare(a.issue.key, b.issue.key) || a.issue.key.localeCompare(b.issue.key) || a.issue.id.localeCompare(b.issue.id);
}

function deadlineTiming(days: number | null): TeamOverviewIssueQueueItem['timing'] {
  if (days === null) return null;
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  return days <= 7 ? 'soon' : 'later';
}

function issueSummary(data: OverviewData, selection: Selection) {
  const selectedProjects = data.projects.filter(project => selection.projectId === null || project.id === selection.projectId);
  const projects: TeamOverviewProject[] = selectedProjects.map(project => ({ projectId: project.id, ...emptyCounts() }));
  const countsByProject = new Map(projects.map(project => [project.projectId, project]));
  const workflows = selectedProjects.map(project => projectWorkflow(data, project.id));
  const activeStatus = { workflows };
  const totals = emptyCounts();
  const matchingIssues = new Map<string, Issue>();
  const deadlines: RankedIssue<TeamOverviewDeadline>[] = [];
  const queue: RankedIssue<TeamOverviewIssueQueueItem>[] = [];
  const referenceDay = calendarDay(selection.date);
  for (const issue of data.issues) {
    const project = countsByProject.get(issue.projectId);
    if (!project || (selection.memberId !== null && !myWorkMembership(issue, selection.memberId))) continue;
    // Recent GitLab links are also useful on terminal tickets.
    matchingIssues.set(issue.id, issue);
    const status = statusMeta(activeStatus, issue.projectId, issue.status);
    if (status.category === 'done' || status.category === 'cancelled') continue;
    const effective = issueDeadline(issue);
    const timing = deadlineTiming(effective ? calendarDay(effective.value) - referenceDay : null);
    const startDate = isCalendarDate(issue.startDate) ? issue.startDate : null;
    const endDate = isCalendarDate(issue.endDate) ? issue.endDate : null;
    const metrics: Record<TeamOverviewIssueMetric, boolean> = {
      open: true, overdue: timing === 'overdue', dueSoon: timing === 'today' || timing === 'soon',
      unscheduled: startDate === null || endDate === null, unassigned: !issue.assigneeId,
    };
    for (const metric of TEAM_OVERVIEW_ISSUE_METRICS) {
      if (!metrics[metric]) continue;
      totals[metric]++;
      project[metric]++;
    }

    const isDeadline = timing !== null && timing !== 'later';
    const inQueue = selection.issueMetric && metrics[selection.issueMetric];
    if (!isDeadline && !inQueue) continue;
    const base = {
      id: issue.id, projectId: issue.projectId, key: issue.key, title: issue.title, assigneeId: issue.assigneeId,
      statusLabel: status.label, statusColor: status.color,
    };
    if (isDeadline && effective) {
      deadlines.push({ priority: issue.priority, issue: { ...base, deadline: effective.value, deadlineSource: effective.source, timing } });
    }
    if (inQueue) {
      queue.push({ priority: issue.priority, issue: {
        ...base, startDate, endDate, priority: issue.priority, deadline: effective?.value ?? null, deadlineSource: effective?.source ?? null, timing,
      } });
    }
  }
  const deadlinePage = page(deadlines.sort(compareRankedIssues), selection.deadlineOffset);
  const queuePage = page(queue.sort(compareRankedIssues), selection.issueOffset);
  const issueQueue = selection.issueMetric && { ...queuePage, metric: selection.issueMetric, items: queuePage.items.map(row => row.issue) };
  return { totals, projects, deadlines: { ...deadlinePage, items: deadlinePage.items.map(row => row.issue) }, issueQueue, matchingIssues };
}

function gitlabSummary(data: OverviewData, selection: Selection, issues: ReturnType<typeof issueSummary>['matchingIssues']): TeamOverviewPage<TeamOverviewGitlabActivity> {
  const rangeStartDay = Math.max(calendarDay(MIN_CALENDAR_DATE), calendarDay(selection.date) - 6);
  const weekStart = reservationDayRange(calendarDate(rangeStartDay))?.startAt ?? `${MIN_CALENDAR_DATE}T00:00:00.000Z`;
  const start = Date.parse(weekStart), end = Date.parse(selection.dayRange.endAt);
  const activities: { activity: TeamOverviewGitlabActivity; updatedAt: number }[] = [];
  for (const link of data.gitlabLinks) {
    const issue = issues.get(link.issueId);
    if (!issue || typeof link.updatedAt !== 'string' || !timestampFormat.test(link.updatedAt) ||
      !isCalendarDate(link.updatedAt.slice(0, 10))) continue;
    const updatedAt = Date.parse(link.updatedAt);
    if (!Number.isFinite(updatedAt) || updatedAt < start || updatedAt >= end) continue;
    activities.push({ updatedAt, activity: { issueId: issue.id, issueKey: issue.key, issueTitle: issue.title, projectId: issue.projectId, link } });
  }
  activities.sort((a, b) => b.updatedAt - a.updatedAt || a.activity.link.id.localeCompare(b.activity.link.id));
  const visible = page(activities, selection.gitlabOffset);
  return { ...visible, items: visible.items.map(entry => entry.activity) };
}

function readOverview({ store, snapshot, timeReservations }: Dependencies, selection: Selection): TeamOverviewResult {
  // All sections read from the same version of the database.
  const own = !store.db.isTransaction;
  if (own) store.db.exec('BEGIN');
  try {
    const { projectId, memberId, date } = selection;
    if (projectId !== null && !store.db.prepare('SELECT id FROM projects WHERE id=?').get(projectId)) {
      throw new TeamOverviewError(404, '프로젝트를 찾을 수 없습니다.');
    }
    if (memberId !== null && !store.db.prepare('SELECT id FROM users WHERE id=?').get(memberId)) {
      throw new TeamOverviewError(400, '등록된 팀원을 선택해 주세요.');
    }
    const data = snapshot();
    const { totals, projects, deadlines, issueQueue, matchingIssues } = issueSummary(data, selection);
    const result = {
      date, timeZone: DEFAULT_RESERVATION_TIME_ZONE, totals, projects, deadlines,
      ...(issueQueue ? { issueQueue } : {}),
      reviews: listPendingTeamReviews(store, { projectId, memberId, offset: selection.reviewOffset, limit: PAGE_SIZE }),
      gitlab: gitlabSummary(data, selection, matchingIssues),
      reservations: timeReservations.calendarPage(selection.dayRange, { projectId, memberId, offset: selection.reservationOffset, limit: PAGE_SIZE }),
    } satisfies TeamOverviewResult;
    if (own) store.db.exec('COMMIT');
    return result;
  } catch (error) {
    if (own) store.db.exec('ROLLBACK');
    throw error;
  }
}

export function registerTeamOverviewRoutes(app: Express, dependencies: Dependencies): void {
  app.get('/api/team-overview', (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { res.json(readOverview(dependencies, readSelection(req.query))); }
    catch (error) {
      if (!(error instanceof TeamOverviewError)) throw error;
      res.status(error.status).json({ error: error.message });
    }
  });
}
