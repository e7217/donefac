import { expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { defaultWorkCalendar, shiftWorkingDate, workingDateOnOrAfter } from '../../shared/calendar';
import { projectIssueSchema } from '../../shared/issue-schema';
import { createIssueViewMatcher } from '../../shared/issue-view';
import type {
  AutomaticSchedulePreview, DocPage, DocRevision, Issue, IssueChangeHistoryPage, IssueRelation, Project, ProjectWorkloadResult, RichContent,
  SavedView, SchedulePasteApplyResult, SchedulePastePreview, SchedulePreview, TeamWorkloadResult, WorkCalendar, WorkspaceSnapshot,
} from '../../shared/types';

type ScheduleApplyResult = { updated: Issue[]; warnings: string[]; undoId: string };
export interface ScheduledSuccessorPlan {
  predecessor: Issue; calendarVersion: number; lagDays: number; startDate: string; endDate: string;
}

async function json<T>(pending: Promise<APIResponse>, status = 200): Promise<T> {
  const response = await pending;
  expect(response.status(), `${response.url()} ${await response.text()}`).toBe(status);
  return await response.json() as T;
}

/** Exercise independent project work while the main document receives concurrent edits. */
export async function verifyWorkspaceTraffic(requests: APIRequestContext, {
  projectId, issueId, actorId, concurrentActor, workingDate: providedDate, origin, createScheduledSuccessor,
}: {
  projectId: string; issueId: string; actorId: string; workingDate?: string; origin?: string;
  concurrentActor: { requests: APIRequestContext; actorId: string };
  createScheduledSuccessor: (plan: ScheduledSuccessorPlan) => Promise<Issue>;
}) {
  const headers = { 'X-Actor-Id': actorId, ...(origin ? { Origin: origin } : {}) };
  const concurrentHeaders = { ...headers, 'X-Actor-Id': concurrentActor.actorId };
  expect(concurrentActor.actorId).not.toBe(actorId);
  expect(concurrentActor.requests).not.toBe(requests);
  const before = await json<WorkspaceSnapshot>(requests.get('/api/workspace', { headers }));
  const issue = before.issues.find(item => item.id === issueId && item.projectId === projectId);
  expect(issue, 'Expected the synthetic pilot issue in its project').toBeDefined();
  if (!issue) throw new Error('Synthetic pilot issue is missing.');

  const calendar = before.calendars?.find(item => item.projectId === projectId) ?? defaultWorkCalendar(projectId);
  const initialDate = workingDateOnOrAfter(providedDate ?? issue.startDate ?? new Date().toISOString().slice(0, 10), calendar);
  const workflow = before.workflows?.find(item => item.projectId === projectId);
  const progress = workflow?.statuses.find(item => item.category === 'in_progress' && item.id !== issue.status);
  if (!progress) throw new Error('The migrated project needs a different in-progress status for the ticket pilot.');
  const plannedEffortMinutes = 95;
  const changes = {
    status: progress.id,
    assigneeId: actorId,
    startDate: initialDate,
    endDate: initialDate,
    plannedEffortMinutes,
  };
  const issuePath = `/api/issues/${encodeURIComponent(issueId)}`;
  const updated = await json<Issue>(requests.patch(issuePath, {
    headers, data: { ...changes, expectedVersion: issue.version },
  }));
  expect(updated).toMatchObject({ id: issueId, projectId, ...changes, version: issue.version + 1 });
  const rejected = await requests.patch(issuePath, {
    headers, data: { expectedVersion: issue.version, plannedEffortMinutes: plannedEffortMinutes + 1 },
  });
  expect(rejected.status()).toBe(409);

  const lagDays = 1;
  const firstAllowedSuccessor = shiftWorkingDate(initialDate, lagDays + 1, calendar);
  const firstSuccessorEnd = shiftWorkingDate(firstAllowedSuccessor, 1, calendar);
  const successor = await createScheduledSuccessor({ predecessor: updated, calendarVersion: calendar.version, lagDays,
    startDate: firstAllowedSuccessor, endDate: firstSuccessorEnd });
  expect(successor).toMatchObject({ projectId, startDate: firstAllowedSuccessor, endDate: firstSuccessorEnd });
  const afterCreate = await json<WorkspaceSnapshot>(requests.get('/api/workspace', { headers }));
  expect(afterCreate.issues.filter(value => value.title === successor.title)).toEqual([successor]);
  const link = { predecessorId: issueId, successorId: successor.id, type: 'FS' as const, lagDays };
  const outgoing = afterCreate.dependencies.filter(value => value.predecessorId === issueId && value.successorId === successor.id);
  expect(outgoing).toEqual([expect.objectContaining(link)]);
  const [dependency] = outgoing;

  const workingDate = shiftWorkingDate(initialDate, 2, calendar);
  const shift = await json<SchedulePreview>(requests.post('/api/schedule/preview', {
    headers, data: { issueIds: [issueId], days: 2, workingDays: true },
  }));
  expect(shift.calendarVersions).toMatchObject({ [projectId]: calendar.version });
  expect(shift.changes).toMatchObject([{ id: issueId, fromStart: initialDate, fromEnd: initialDate,
    toStart: workingDate, toEnd: workingDate, version: updated.version }]);
  expect(shift.warnings.some(warning => warning.includes(successor.key) && warning.includes('FS'))).toBe(true);
  const moved = await json<ScheduleApplyResult>(requests.post('/api/schedule/apply', {
    headers, data: { calendarVersions: shift.calendarVersions, changes: shift.changes.map(change => ({
      id: change.id, expectedVersion: change.version, startDate: change.toStart, endDate: change.toEnd,
    })) },
  }));
  expect(moved.updated).toMatchObject([{ ...changes, id: issueId, projectId, version: updated.version + 1,
    startDate: workingDate, endDate: workingDate }]);

  const successorStart = shiftWorkingDate(workingDate, lagDays + 1, calendar);
  const successorEnd = shiftWorkingDate(successorStart, 1, calendar);
  const auto = await json<AutomaticSchedulePreview>(requests.post('/api/schedule/auto-preview', {
    headers, data: { projectId, issueIds: [issueId] },
  }));
  expect(auto.blocking).toEqual([]);
  expect(auto.changes).toMatchObject([{ id: successor.id, fromStart: successor.startDate, fromEnd: successor.endDate,
    toStart: successorStart, toEnd: successorEnd, version: successor.version }]);
  const corrected = await json<ScheduleApplyResult>(requests.post('/api/schedule/auto-apply', {
    headers, data: { previewId: auto.previewId },
  }));
  expect(corrected.updated).toMatchObject([{ id: successor.id, projectId, startDate: successorStart, endDate: successorEnd,
    version: successor.version + 1 }]);
  expect(corrected.warnings).toEqual([]);

  const otherProject = await json<Project>(requests.post('/api/projects', {
    headers, data: { key: 'TEAM2', name: '합성 팀 연계 프로젝트' },
  }), 201);
  const otherIssue = await json<Issue>(requests.post('/api/issues', {
    headers, data: { projectId: otherProject.id, title: '다른 프로젝트의 공동 마감 업무' },
  }), 201);
  const reviewDueDates = (issues: readonly Issue[]) => json<SchedulePastePreview>(requests.post('/api/schedule/bulk-dates/preview', {
    headers, data: { projectId: null, issues: issues.map(({ id, version }) => ({ id, expectedVersion: version })),
      changes: { dueDate: successorEnd } },
  }));
  const firstReview = await reviewDueDates([moved.updated[0], otherIssue]);
  expect(firstReview.errors).toEqual([]);
  expect(firstReview.previewId).toBeTruthy();
  expect(firstReview.changes).toHaveLength(2);

  const competingEdit = { startDate: workingDate, endDate: workingDate };
  const competingReview = await json<SchedulePastePreview>(concurrentActor.requests.post('/api/schedule/bulk-dates/preview', {
    headers: concurrentHeaders, data: { projectId: otherProject.id, issues: [{ id: otherIssue.id, expectedVersion: otherIssue.version }], changes: competingEdit },
  }));
  expect(competingReview.errors).toEqual([]);
  expect(competingReview.previewId).toBeTruthy();
  expect(competingReview.changes).toMatchObject([{ id: otherIssue.id, fromStart: null, fromEnd: null, toStart: workingDate, toEnd: workingDate }]);
  const competingSave = await json<SchedulePasteApplyResult>(concurrentActor.requests.post('/api/schedule/bulk-dates/apply', {
    headers: concurrentHeaders, data: { previewId: competingReview.previewId },
  }));
  const [competingIssue] = competingSave.updated;
  expect(competingSave.updated).toHaveLength(1);
  expect(competingIssue).toMatchObject({ id: otherIssue.id, ...competingEdit, dueDate: null, version: otherIssue.version + 1 });

  const stale = await json<{ error: string }>(requests.post('/api/schedule/bulk-dates/apply', {
    headers, data: { previewId: firstReview.previewId },
  }), 409);
  expect(stale.error).toContain('업무, 연결된 일정 또는 프로젝트 규칙이 변경되었습니다.');
  const refreshed = await json<WorkspaceSnapshot>(requests.get('/api/workspace', { headers }));
  const latestIssue = refreshed.issues.find(value => value.id === issueId);
  const latestOtherIssue = refreshed.issues.find(value => value.id === otherIssue.id);
  expect(latestIssue).toEqual(moved.updated[0]);
  expect(latestOtherIssue).toEqual(competingIssue);
  if (!latestIssue || !latestOtherIssue) throw new Error('The reviewed schedule issues must still be in the workspace.');

  const bulk = await reviewDueDates([latestIssue, latestOtherIssue]);
  expect(bulk.errors).toEqual([]);
  expect(new Set(bulk.projectIds)).toEqual(new Set([projectId, otherProject.id]));
  expect(bulk.previewId).toBeTruthy();
  expect(bulk.previewId).not.toBe(firstReview.previewId);
  expect(bulk.changes).toHaveLength(2);
  expect(bulk.changes.every(change => change.toDue === successorEnd)).toBe(true);
  expect(bulk.changes.find(change => change.id === otherIssue.id)).toMatchObject({ fromStart: workingDate, fromEnd: workingDate,
    toStart: workingDate, toEnd: workingDate, version: competingIssue.version });
  const batch = await json<SchedulePasteApplyResult>(requests.post('/api/schedule/bulk-dates/apply', {
    headers, data: { previewId: bulk.previewId },
  }));
  const coordinated = batch.updated.find(value => value.id === issueId);
  const secondary = batch.updated.find(value => value.id === otherIssue.id);
  expect(coordinated).toMatchObject({ startDate: workingDate, endDate: workingDate, dueDate: successorEnd, version: moved.updated[0].version + 1 });
  expect(secondary).toMatchObject({ projectId: otherProject.id, ...competingEdit, dueDate: successorEnd, version: competingIssue.version + 1 });
  const history = await json<IssueChangeHistoryPage>(requests.get(`/api/issues/${otherIssue.id}/change-history`, { headers }));
  const competingRevision = history.entries.find(entry => entry.issueVersion === competingIssue.version);
  expect(competingRevision).toMatchObject({ issueId: otherIssue.id, actorId: concurrentActor.actorId, changes: expect.arrayContaining([
    { field: 'startDate', label: expect.any(String), before: expect.objectContaining({ value: null }), after: expect.objectContaining({ value: workingDate }) },
    { field: 'endDate', label: expect.any(String), before: expect.objectContaining({ value: null }), after: expect.objectContaining({ value: workingDate }) },
  ]) });
  expect(history.entries[0]).toMatchObject({ actorId, issueVersion: competingIssue.version + 1,
    changes: [{ field: 'dueDate', label: expect.any(String), before: expect.objectContaining({ value: null }), after: expect.objectContaining({ value: successorEnd }) }] });
  if (!competingRevision) throw new Error('The concurrent date edit must remain in the issue history.');

  const calendarPath = `/api/projects/${otherProject.id}/calendar`;
  const otherCalendar = await json<WorkCalendar>(requests.get(calendarPath, { headers }));
  const anchorDate = shiftWorkingDate(workingDate, 1, calendar);
  const dayOff = shiftWorkingDate(anchorDate, 1, otherCalendar);
  const changedCalendar = await json<WorkCalendar>(requests.patch(calendarPath, { headers, data: {
    expectedVersion: otherCalendar.version, exceptions: [{ date: dayOff, isWorking: false, label: '합성 후행 프로젝트 휴무' }],
  } }));
  const handoffDate = shiftWorkingDate(anchorDate, 1, changedCalendar);
  expect(handoffDate > dayOff).toBe(true);
  const anchor = await json<Issue>(requests.post('/api/issues', { headers, data: {
    projectId, title: '프로젝트 간 인계 선행 업무', startDate: workingDate, endDate: workingDate,
  } }), 201);
  const downstream = await json<Issue>(requests.post('/api/issues', { headers, data: {
    projectId: otherProject.id, title: '프로젝트 간 인계 일정', startDate: workingDate, endDate: workingDate,
  } }), 201);
  const blocker = await json<IssueRelation>(requests.post(`/api/issues/${encodeURIComponent(anchor.id)}/relations`, { headers, data: {
    otherIssueId: downstream.id, type: 'blocks', direction: 'outgoing',
  } }), 201);
  const handoff = await json<AutomaticSchedulePreview>(requests.post('/api/schedule/team-follow-up-preview', { headers, data: {
    relationId: blocker.id, expectedVersion: blocker.version,
    anchorChange: { id: anchor.id, expectedVersion: anchor.version, startDate: anchorDate, endDate: anchorDate },
  } }));
  expect(handoff.teamFollowUp).toMatchObject({ sourceIssueId: anchor.id, targetIssueId: downstream.id, sourceEndDate: anchorDate,
    sourceSchedule: { version: anchor.version, startDate: workingDate, endDate: workingDate } });
  expect(handoff.blocking).toEqual([]);
  expect(handoff.changes).toMatchObject([
    { id: anchor.id, projectId, toStart: anchorDate, toEnd: anchorDate },
    { id: downstream.id, projectId: otherProject.id, toStart: handoffDate, toEnd: handoffDate },
  ]);
  const handedOff = await json<ScheduleApplyResult>(requests.post('/api/schedule/team-follow-up-apply', { headers, data: {
    previewId: handoff.previewId,
  } }));
  expect(handedOff.updated).toMatchObject([
    { id: anchor.id, projectId, startDate: anchorDate, endDate: anchorDate, version: anchor.version + 1 },
    { id: downstream.id, projectId: otherProject.id, startDate: handoffDate, endDate: handoffDate, version: downstream.version + 1 },
  ]);

  const dateQuery = new URLSearchParams({ startDate: workingDate, endDate: workingDate });
  const filters = { query: issue.key, status: changes.status, assigneeId: actorId, type: 'all' };
  const [projectWorkload, teamWorkload, view] = await Promise.all([
    json<ProjectWorkloadResult>(requests.get(`/api/projects/${encodeURIComponent(projectId)}/workload?${dateQuery}`, { headers })),
    json<TeamWorkloadResult>(requests.get(`/api/workload?${dateQuery}&projectId=${encodeURIComponent(projectId)}`, { headers })),
    json<SavedView>(requests.post('/api/views', {
      headers, data: { projectId, name: `${issue.key} 파일럿 계획`, layout: 'list', filters },
    }), 201),
  ]);
  const projectDay = projectWorkload.rows.find(row => row.userId === actorId)?.days.find(day => day.date === workingDate);
  const teamDay = teamWorkload.rows.find(row => row.userId === actorId)?.days.find(day => day.date === workingDate);
  expect(projectDay?.allocations.filter(allocation => allocation.issueId === issueId)).toEqual([{ issueId, minutes: plannedEffortMinutes }]);
  expect(teamWorkload.projectIds).toEqual([projectId]);
  expect(teamDay?.allocations.filter(allocation => allocation.issueId === issueId)).toEqual([{ issueId, projectId, minutes: plannedEffortMinutes }]);

  const note: RichContent = {
    type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: '파일럿의 일정과 상태를 읽는 문서' }] },
      { type: 'issueList', attrs: { projectId, savedViewId: view.id, label: view.name } },
    ],
  };
  const document = await json<DocPage>(requests.post('/api/documents', {
    headers, data: { projectId, title: `${issue.key} 계획 검토`, content: note },
  }), 201);
  const [current, revisions] = await Promise.all([
    json<WorkspaceSnapshot>(requests.get('/api/workspace', { headers })),
    json<DocRevision[]>(requests.get(`/api/documents/${encodeURIComponent(document.id)}/revisions`, { headers })),
  ]);
  expect(current.issues.find(item => item.id === issueId)).toEqual(coordinated);
  expect(current.issues.find(item => item.id === otherIssue.id)).toEqual(secondary);
  expect(current.issues.find(item => item.id === anchor.id)).toEqual(handedOff.updated[0]);
  expect(current.issues.find(item => item.id === downstream.id)).toEqual(handedOff.updated[1]);
  expect(current.calendars?.find(item => item.projectId === otherProject.id)).toEqual(changedCalendar);
  expect(current.issues.find(item => item.id === successor.id)).toEqual(corrected.updated[0]);
  expect(current.dependencies.find(item => item.id === dependency.id)).toEqual(dependency);
  expect(current.documents.find(item => item.id === document.id)).toMatchObject({ authorId: actorId, projectId, content: note });
  expect(revisions[0]).toMatchObject({ authorId: actorId, documentId: document.id, version: document.version, content: note });
  const savedView = current.savedViews?.find(item => item.id === view.id && item.projectId === projectId);
  expect(savedView).toBeDefined();
  if (!savedView) throw new Error('Synthetic pilot saved view is missing.');
  expect(savedView.filters).toMatchObject(filters);
  const matches = createIssueViewMatcher(savedView.filters, current, projectIssueSchema(current, projectId));
  expect(current.issues.filter(item => item.projectId === projectId && matches(item)).map(item => item.id)).toEqual([issueId]);

  return {
    issueId, issueVersion: moved.updated[0].version + 1, issueListDocumentId: document.id, plannedEffortMinutes, workingDate,
    bulkDates: { previewId: bulk.previewId, undoId: batch.undoId, dueDate: successorEnd,
      otherProjectId: otherProject.id, otherIssueId: otherIssue.id, otherIssueVersion: competingIssue.version + 1,
      competingEdit: { actorId: concurrentActor.actorId, date: workingDate, version: competingIssue.version,
        previewId: competingReview.previewId, undoId: competingSave.undoId, historyId: competingRevision.id },
    },
    handoff: { anchorId: anchor.id, anchorDate, issueId: downstream.id, date: handoffDate, dayOff,
      relationId: blocker.id, previewId: handoff.previewId, undoId: handedOff.undoId },
    scheduledSuccessor: { issueId: successor.id, issueVersion: corrected.updated[0].version, startDate: successorStart,
      endDate: successorEnd, dependencyId: dependency.id, lagDays },
  };
}
