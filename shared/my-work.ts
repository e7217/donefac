import { calendarDay, isCalendarDate } from './calendar.js';
import { PRIORITY, type Issue, type Priority, type Project, type StatusCategory, type WorkflowStatus, type WorkspaceSnapshot } from './types.js';
import { statusMeta } from './workflow-helpers.js';

export type MyWorkRole = 'assigned' | 'collaborating';
export type MyWorkRoleFilter = 'all' | MyWorkRole;
export type MyWorkGrouping = 'deadline' | 'status';

const deadlineGroups = ['overdue', 'today', 'next-seven-days', 'later', 'undated', 'closed'] as const;
const statusGroups: readonly StatusCategory[] = ['in_progress', 'review', 'todo', 'backlog', 'done', 'cancelled'];
type DeadlineGroup = typeof deadlineGroups[number];
export type MyWorkGroupId = DeadlineGroup | StatusCategory;

export interface MyWorkItem {
  issue: Issue;
  project: Project;
  status: WorkflowStatus;
  role: MyWorkRole;
  date: { value: string; source: 'dueDate' | 'endDate' } | null;
}

interface MyWorkFilters {
  projectId: string | null;
  role: MyWorkRoleFilter;
  includeClosed: boolean;
  grouping: MyWorkGrouping;
}

type MyWorkData = Pick<WorkspaceSnapshot, 'projects' | 'issues' | 'workflows' | 'issueSchemas'>;

const priorities = Object.keys(PRIORITY) as Priority[];
const issueKeys = new Intl.Collator('ko', { numeric: true });

export function myWorkMembership(issue: Pick<Issue, 'assigneeId' | 'collaboratorIds'>, actorId: string): MyWorkRole | null {
  if (!actorId.trim()) return null;
  if (issue.assigneeId === actorId) return 'assigned';
  return issue.collaboratorIds.includes(actorId) ? 'collaborating' : null;
}

function isClosed(status: StatusCategory): boolean {
  return status === 'done' || status === 'cancelled';
}

export function countActiveMyWork(data: MyWorkData, actorId: string): number {
  const projects = new Set(data.projects.map(project => project.id));
  return data.issues.filter(issue => myWorkMembership(issue, actorId) && projects.has(issue.projectId) &&
    !isClosed(statusMeta(data, issue.projectId, issue.status).category)).length;
}

export function issueDeadline(issue: Pick<Issue, 'dueDate' | 'endDate'>): MyWorkItem['date'] {
  if (isCalendarDate(issue.dueDate)) return { value: issue.dueDate, source: 'dueDate' };
  return isCalendarDate(issue.endDate) ? { value: issue.endDate, source: 'endDate' } : null;
}

function deadlineGroup(item: MyWorkItem, today: number): DeadlineGroup {
  if (isClosed(item.status.category)) return 'closed';
  if (!item.date) return 'undated';
  const difference = calendarDay(item.date.value) - today;
  if (difference < 0) return 'overdue';
  if (difference === 0) return 'today';
  return difference <= 7 ? 'next-seven-days' : 'later';
}

function compareKeys(left: Issue, right: Issue): number {
  return issueKeys.compare(left.key, right.key) || left.key.localeCompare(right.key) || left.id.localeCompare(right.id);
}

function compareRecent(left: Issue, right: Issue): number {
  return (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0);
}

function compareOpen(left: MyWorkItem, right: MyWorkItem): number {
  const priority = priorities.indexOf(left.issue.priority) - priorities.indexOf(right.issue.priority);
  if (left.date && right.date) {
    return left.date.value.localeCompare(right.date.value) || priority || compareKeys(left.issue, right.issue);
  }
  if (left.date || right.date) return left.date ? -1 : 1;
  return priority || compareRecent(left.issue, right.issue) || compareKeys(left.issue, right.issue);
}

export function buildMyWorkQueue(data: MyWorkData, actorId: string, today: string, options: MyWorkFilters) {
  const groups = (options.grouping === 'deadline' ? deadlineGroups : statusGroups)
    .map(id => ({ id, items: [] as MyWorkItem[] }));
  const groupById = new Map<MyWorkGroupId, MyWorkItem[]>(groups.map(group => [group.id, group.items]));
  const projectById = new Map(data.projects.map(project => [project.id, project]));
  const todayDay = calendarDay(today);
  let total = 0;
  for (const issue of data.issues) {
    const role = myWorkMembership(issue, actorId);
    if (!role || (options.role !== 'all' && role !== options.role) ||
        (options.projectId !== null && issue.projectId !== options.projectId)) continue;

    const project = projectById.get(issue.projectId);
    if (!project) continue;
    const status = statusMeta(data, issue.projectId, issue.status);
    if (!options.includeClosed && isClosed(status.category)) continue;

    const item: MyWorkItem = { issue, project, status, role, date: issueDeadline(issue) };
    const groupId = options.grouping === 'deadline' ? deadlineGroup(item, todayDay) : status.category;
    groupById.get(groupId)!.push(item);
    total++;
  }

  for (const { id, items } of groups) {
    if (id === 'closed' || id === 'done' || id === 'cancelled') {
      items.sort((left, right) => compareRecent(left.issue, right.issue) || compareKeys(left.issue, right.issue));
    } else {
      items.sort(compareOpen);
    }
  }
  return { groups, total };
}
