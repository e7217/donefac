import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultWorkCalendar, createCalendarMath } from '../../shared/calendar.js';
import { buildGanttExportReport } from '../../shared/gantt-export-model.js';
import { checkDependencySchedule } from '../../shared/schedule-dependencies.js';
import type { Dependency, Issue, Milestone, PlanningItem, Project, ScheduleBaseline, User } from '../../shared/types.js';
import { defaultWorkflow } from '../../shared/workflow-helpers.js';

const capturedAt = '2026-11-20T12:34:56.000Z';
const project: Project = { id: 'internal-project', key: 'TEAM', name: '팀 프로젝트', description: '프로젝트 본문', color: '#6688aa', createdAt: capturedAt };
const user: User = { id: 'internal-user', name: '담당 팀원', email: 'hidden@example.test', color: '#6688aa' };
const workflow = defaultWorkflow(project.id);
workflow.statuses[0] = { ...workflow.statuses[0], label: '준비 단계' };
const calendar = defaultWorkCalendar(project.id);

function issue(key: string, fields: Partial<Issue> = {}): Issue {
  return {
    id: `internal-issue-${key}`, key, projectId: project.id, title: key, description: '출력하지 않을 업무 본문',
    type: '작업', status: 'backlog', priority: 'medium', assigneeId: user.id, collaboratorIds: [], parentId: null,
    labels: [], startDate: null, endDate: null, dueDate: null, estimate: null, cycle: null, module: null, release: null,
    customFields: { field: '출력하지 않을 사용자 정의 값' }, version: 1, createdAt: capturedAt, updatedAt: capturedAt,
    completedAt: null, ...fields,
  };
}

const plan: PlanningItem = {
  id: 'internal-plan', projectId: project.id, kind: 'release', name: '릴리스 계획', description: '출력하지 않을 계획 본문',
  status: 'active', ownerId: user.id, startDate: '2026-11-14', endDate: '2026-11-28', targetDate: '2026-11-30',
  createdAt: capturedAt, updatedAt: capturedAt, version: 1,
};
const milestone: Milestone = {
  id: 'internal-milestone', projectId: project.id, title: '실행 검토', description: '출력하지 않을 마일스톤 본문',
  date: '2026-11-27', status: 'reached', ownerId: null, issueIds: [],
  createdAt: capturedAt, updatedAt: capturedAt, version: 1,
};

test('Gantt export retains chart order, full dates and baseline references for visible rows only', () => {
  const predecessor = issue('TEAM-2', { title: '선행 업무', startDate: '2026-11-10', endDate: '2026-11-19', dueDate: '2026-11-30' });
  const successor = issue('TEAM-1', { title: '후행 업무', startDate: '2026-11-18', status: 'todo', assigneeId: null });
  const hidden = issue('TEAM-3', { title: '필터로 가려진 업무' });
  const historical = { issueId: 'internal-deleted-issue', key: 'TEAM-5', title: '삭제된 기준선 업무', startDate: '2026-11-23', endDate: null, sourceVersion: 1 };
  const historicalMilestone = { milestoneId: 'internal-deleted-milestone', title: '이전 시연', date: '2026-11-08', status: 'open' as const, sourceVersion: 1 };
  const baseline: ScheduleBaseline = {
    id: 'internal-baseline', projectId: project.id, name: '협의 기준', description: '출력하지 않을 기준선 본문',
    authorId: user.id, version: 2, createdAt: capturedAt, calendar,
    issues: [historical, {
      issueId: predecessor.id, key: predecessor.key, title: '예전 업무명', startDate: '2026-11-09', endDate: '2026-11-17', sourceVersion: 1,
    }, { issueId: hidden.id, key: hidden.key, title: hidden.title, startDate: null, endDate: null, sourceVersion: 1 }],
    milestones: [historicalMilestone, { milestoneId: milestone.id, title: '이전 검토명', date: '2026-11-26', status: 'open', sourceVersion: 1 }],
  };
  const visibleLink: Dependency = { id: 'internal-visible-link', predecessorId: predecessor.id, successorId: successor.id, type: 'FS', lagDays: 1 };
  const hiddenLink: Dependency = { ...visibleLink, id: 'internal-hidden-link', successorId: hidden.id };
  const check = checkDependencySchedule(visibleLink, predecessor, successor, createCalendarMath(calendar));
  assert.equal(check.kind, 'conflict');
  const input = {
    title: 'TEAM · 팀 프로젝트', capturedAt, range: { startDate: '2026-11-17', endDate: '2026-11-24' },
    today: '2026-11-20', nonworkingDates: ['2026-11-21', '2026-11-22'], filters: ['공유 보기 · 이번 주'],
    data: { users: [user], projects: [project], workflows: [workflow] }, issues: [successor, predecessor],
    planningRows: [plan], milestones: [milestone], baseline,
    historicalIssues: [historical], historicalMilestones: [historicalMilestone], dependencies: [hiddenLink, visibleLink],
  };
  const report = buildGanttExportReport({ ...input, findings: new Map([[visibleLink.id, check]]) });
  assert.equal(report.baselineName, baseline.name);
  assert.deepEqual(report.range, input.range);
  assert.deepEqual(report.filters, input.filters);
  assert.deepEqual(report.rows.map(row => [row.kind, row.key, row.title]), [
    ['plan', null, plan.name], ['issue', successor.key, successor.title], ['issue', predecessor.key, predecessor.title],
    ['issue', historical.key, historical.title], ['milestone', null, milestone.title], ['milestone', null, historicalMilestone.title],
  ]);
  assert.equal(report.rows[0].kindLabel, '릴리스');
  assert.equal(report.rows[1].endDate, null);
  assert.equal(report.rows[2].startDate, '2026-11-10');
  assert.equal(report.rows[2].targetDate, '2026-11-30');
  assert.equal(report.rows[2].status, '준비 단계');
  assert.equal(report.rows[2].assignee, user.name);
  assert.deepEqual(report.rows[2].baseline, { startDate: '2026-11-09', endDate: '2026-11-17', targetDate: null });
  assert.deepEqual([report.rows[3].startDate, report.rows[3].baseline?.startDate, report.rows[3].historical], [null, '2026-11-23', true]);
  assert.deepEqual([report.rows[4].targetDate, report.rows[4].baseline?.targetDate], ['2026-11-27', '2026-11-26']);
  assert.deepEqual([report.rows[5].targetDate, report.rows[5].baseline?.targetDate, report.rows[5].historical], [null, '2026-11-08', true]);
  assert.deepEqual(report.dependencies, [{ predecessorKey: predecessor.key, successorKey: successor.key, type: 'FS', lagDays: 1, check }]);

  const serialized = JSON.stringify(report);
  for (const privateValue of ['internal-', hidden.title, hidden.key, user.email, '출력하지 않을', '예전 업무명', '이전 검토명']) {
    assert.ok(!serialized.includes(privateValue), privateValue);
  }
  assert.equal(buildGanttExportReport({ ...input, findings: new Map() }).dependencies[0].check?.kind, 'valid');
  assert.equal(buildGanttExportReport(input).dependencies[0].check, null);
  assert.ok(report.rows.every(row => row.projectName === undefined));

  const other = { ...project, id: 'internal-second-project', key: 'QA', name: '검증 프로젝트' };
  const receiver = issue('QA-1', { projectId: other.id, startDate: '2026-11-18' });
  const teamLink: Dependency = { ...visibleLink, id: 'internal-team-link', successorId: receiver.id, lagDays: 0 };
  const teamCheck = checkDependencySchedule(teamLink, predecessor, receiver, createCalendarMath(defaultWorkCalendar(other.id)));
  assert.equal(teamCheck.kind, 'conflict');
  const teamReport = buildGanttExportReport({
    ...input, includeProjectLabel: true, nonworkingDates: [],
    data: { ...input.data, projects: [project, other] },
    issues: [successor, receiver, predecessor], dependencies: [...input.dependencies, teamLink],
    teamBlockerIds: new Set([teamLink.id, hiddenLink.id]), findings: new Map([[visibleLink.id, check], [teamLink.id, teamCheck]]),
  });
  assert.deepEqual(teamReport.rows.filter(row => row.kind === 'issue' && !row.historical).map(row => [row.key, row.projectName]),
    [[successor.key, project.name], ['QA-1', other.name], [predecessor.key, project.name]]);
  assert.deepEqual(teamReport.dependencies, [...report.dependencies,
    { predecessorKey: predecessor.key, successorKey: receiver.key, type: 'FS', lagDays: 0, check: teamCheck, teamBlocker: true }]);
  assert.doesNotMatch(JSON.stringify(teamReport), /internal-team-link|internal-hidden-link/);
  assert.deepEqual(teamReport.nonworkingDates, []);
});
