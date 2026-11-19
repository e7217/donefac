import { expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { defaultWorkCalendar, workingDateOnOrAfter } from '../../shared/calendar';
import { projectIssueSchema } from '../../shared/issue-schema';
import { createIssueViewMatcher } from '../../shared/issue-view';
import type { DocPage, DocRevision, Issue, ProjectWorkloadResult, RichContent, SavedView, TeamWorkloadResult, WorkspaceSnapshot } from '../../shared/types';

async function json<T>(pending: Promise<APIResponse>, status = 200): Promise<T> {
  const response = await pending;
  expect(response.status(), `${response.url()} ${await response.text()}`).toBe(status);
  return await response.json() as T;
}

/** Exercise independent project work while the main document receives concurrent edits. */
export async function verifyWorkspaceTraffic(requests: APIRequestContext, {
  projectId, issueId, actorId, workingDate: providedDate,
}: { projectId: string; issueId: string; actorId: string; workingDate?: string }) {
  const headers = { 'X-Actor-Id': actorId };
  const before = await json<WorkspaceSnapshot>(requests.get('/api/workspace', { headers }));
  const issue = before.issues.find(item => item.id === issueId && item.projectId === projectId);
  expect(issue, 'Expected the synthetic pilot issue in its project').toBeDefined();
  if (!issue) throw new Error('Synthetic pilot issue is missing.');

  const calendar = before.calendars?.find(item => item.projectId === projectId) ?? defaultWorkCalendar(projectId);
  const workingDate = providedDate ?? workingDateOnOrAfter(new Date().toISOString().slice(0, 10), calendar);
  const plannedEffortMinutes = 95;
  const changes = {
    status: issue.status === 'in_progress' ? 'review' : 'in_progress',
    assigneeId: actorId,
    startDate: workingDate,
    endDate: workingDate,
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
  expect(current.issues.find(item => item.id === issueId)).toEqual(updated);
  expect(current.documents.find(item => item.id === document.id)).toMatchObject({ authorId: actorId, projectId, content: note });
  expect(revisions[0]).toMatchObject({ authorId: actorId, documentId: document.id, version: document.version, content: note });
  const savedView = current.savedViews?.find(item => item.id === view.id && item.projectId === projectId);
  expect(savedView).toBeDefined();
  if (!savedView) throw new Error('Synthetic pilot saved view is missing.');
  expect(savedView.filters).toMatchObject(filters);
  const matches = createIssueViewMatcher(savedView.filters, current, projectIssueSchema(current, projectId));
  expect(current.issues.filter(item => item.projectId === projectId && matches(item)).map(item => item.id)).toEqual([issueId]);

  return { issueId, issueVersion: updated.version, issueListDocumentId: document.id, plannedEffortMinutes, workingDate };
}
