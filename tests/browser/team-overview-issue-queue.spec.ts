import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Locator } from '@playwright/test';
import type { Issue, Project, SchedulePreview, WorkspaceSnapshot } from '../../shared/types';

test.use({ viewport: { width: 360, height: 820 }, timezoneId: 'America/Los_Angeles' });

async function workspace(request: APIRequestContext): Promise<WorkspaceSnapshot> {
  const response = await request.get('/api/workspace');
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

async function discardIssue(request: APIRequestContext, issue: Issue) {
  const deleted = await request.delete(`/api/issues/${issue.id}`);
  if (deleted.ok()) {
    const { trashEntryId } = await deleted.json() as { trashEntryId: string };
    await request.delete(`/api/trash/${trashEntryId}`);
  }
}

test('360px 팀 개요에서 업무 지표를 열고 간트의 날짜를 채운 뒤 같은 목록 페이지로 돌아온다', async ({ page, request }) => {
  test.setTimeout(120_000);
  const { projects: [otherProject], users: [member, otherMember] } = await workspace(request);
  const key = `TQ${randomUUID().slice(0, 8).toUpperCase()}`;
  const projectReply = await request.post('/api/projects', { data: { key, name: `${key} 일정 확인` } });
  expect(projectReply.status(), await projectReply.text()).toBe(201);
  const project = await projectReply.json() as Project;
  const date = '2041-04-10';
  const created: Issue[] = [];
  async function createIssue(label: string, attributes: Partial<Issue>) {
    const response = await request.post('/api/issues', { data: {
      projectId: project.id, assigneeId: member.id, title: `${key} ${label}`, ...attributes,
    } });
    expect(response.status(), await response.text()).toBe(201);
    const issue = await response.json() as Issue;
    created.push(issue);
    return issue;
  }

  try {
    const overdue = await createIssue('시작일이 비어 있는 협력 업무', {
      assigneeId: otherMember.id, collaboratorIds: [member.id], dueDate: '2041-04-09', endDate: '2041-04-12',
    });
    const today = await createIssue('오늘 목표 마감 업무', { dueDate: date, startDate: '2041-04-09', endDate: '2041-04-15' });
    const unassigned = await createIssue('미배정 협력 업무', {
      assigneeId: null, collaboratorIds: [member.id], startDate: date, endDate: '2041-04-17',
    });
    const terminal = await createIssue('마감이 지난 완료 업무', { status: 'done', dueDate: '2041-04-08' });
    const foreignMember = await createIssue('다른 팀원의 미정 업무', { assigneeId: otherMember.id, dueDate: '1999-01-01' });
    const foreignProject = await createIssue('다른 프로젝트의 담당 업무', {
      projectId: otherProject.id, dueDate: '1998-01-03', startDate: '1998-01-01', endDate: '1998-01-02',
    });
    const pending: Issue[] = [];
    for (let index = 1; index <= 11; index++) {
      pending.push(await createIssue(`종료일 미정 업무 ${index}`, { dueDate: '2041-04-19', startDate: '2041-04-09' }));
    }
    const repair = await createIssue('간트에서 종료일을 채울 업무', { dueDate: '2041-04-24', startDate: '2041-04-23' });

    const path = `#/${project.id}/teamoverview`;
    const hashParameters = () => new URLSearchParams(new URL(page.url()).hash.split('?')[1]);
    const metric = (title: string) => page.getByRole('button', { name: title, exact: true });
    const region = (title: string) => page.getByRole('region', { name: title, exact: true });
    const listItem = (section: Locator, issue: Issue) => section.getByRole('listitem').filter({ hasText: issue.title });
    await page.goto(`/${path}?${new URLSearchParams({ teamMember: member.id, teamDate: date })}`);
    await expect(region('마감 확인')).toBeVisible();

    const overdueTitle = '마감 초과';
    const overdueRegion = region(overdueTitle);
    await metric(overdueTitle).click();
    await expect(metric(overdueTitle)).toHaveAttribute('aria-pressed', 'true');
    await expect(listItem(overdueRegion, foreignProject)).toBeVisible();
    await expect(listItem(overdueRegion, foreignMember)).toHaveCount(0);
    await page.getByLabel('프로젝트 필터', { exact: true }).selectOption(project.id);
    await expect(overdueRegion.getByRole('listitem')).toHaveCount(1);
    await expect(listItem(overdueRegion, overdue)).toBeVisible();
    await expect(listItem(overdueRegion, foreignProject)).toHaveCount(0);
    await expect.poll(() => [hashParameters().get('teamProject'), hashParameters().get('teamMember'), hashParameters().get('teamDate'), hashParameters().get('teamQueue')])
      .toEqual([project.id, member.id, date, 'overdue']);

    const soonTitle = '오늘부터 7일 이내';
    await metric(soonTitle).click();
    await expect(region(soonTitle).getByRole('listitem')).toHaveCount(2);
    await expect(listItem(region(soonTitle), today)).toBeVisible();
    await expect(listItem(region(soonTitle), unassigned)).toBeVisible();

    const unassignedTitle = '미배정';
    await metric(unassignedTitle).click();
    await expect(region(unassignedTitle).getByRole('listitem')).toHaveCount(1);
    await expect(listItem(region(unassignedTitle), unassigned)).toBeVisible();
    await listItem(region(unassignedTitle), unassigned).getByRole('button', { name: new RegExp(unassigned.title) }).click();
    const unassignedTicket = page.getByRole('dialog', { name: unassigned.title, exact: true });
    await unassignedTicket.getByLabel('담당자', { exact: true }).selectOption(member.id);
    await unassignedTicket.getByRole('button', { name: '변경사항 저장', exact: true }).click();
    await unassignedTicket.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(metric(unassignedTitle)).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await workspace(request)).issues.find(issue => issue.id === unassigned.id)?.assigneeId).toBe(member.id);
    await expect(region(unassignedTitle)).toHaveAttribute('aria-busy', 'false');
    await expect(region(unassignedTitle).getByRole('listitem')).toHaveCount(0);

    const openTitle = '열린 업무';
    await metric(openTitle).click();
    await expect(region(openTitle).getByRole('listitem')).toHaveCount(10);
    for (const issue of [overdue, today, unassigned]) await expect(listItem(region(openTitle), issue)).toBeVisible();
    await expect(listItem(region(openTitle), terminal)).toHaveCount(0);

    const unscheduledTitle = '일정 미정';
    const unscheduled = region(unscheduledTitle);
    await metric(unscheduledTitle).click();
    await expect(listItem(unscheduled, overdue).getByRole('button', { name: `${overdue.key} 시작일 입력`, exact: true })).toBeVisible();
    await expect(unscheduled.getByRole('listitem')).toHaveCount(10);
    await expect(listItem(unscheduled, repair)).toHaveCount(0);
    await unscheduled.getByRole('button', { name: '다음', exact: true }).click();
    await expect(unscheduled.getByRole('listitem')).toHaveCount(3);
    await expect(listItem(unscheduled, pending[9])).toBeVisible();
    await expect(listItem(unscheduled, pending[10])).toBeVisible();
    await expect(listItem(unscheduled, repair)).toBeVisible();
    const queueBounds = await unscheduled.boundingBox();
    expect(queueBounds).not.toBeNull();
    expect(queueBounds!.x + queueBounds!.width).toBeLessThanOrEqual(360);
    await expect.poll(() => hashParameters().get('teamQueueOffset')).toBe('10');
    const queueHash = new URL(page.url()).hash;

    await listItem(unscheduled, repair).getByRole('button', { name: new RegExp(repair.title) }).click();
    const ticket = page.getByRole('dialog', { name: repair.title, exact: true });
    await expect(ticket).toBeVisible();
    await expect.poll(() => [hashParameters().get('issue'), hashParameters().get('teamQueueOffset')]).toEqual([repair.id, '10']);
    await ticket.getByRole('button', { name: '업무 상세 닫기', exact: true }).click();
    await expect(page).toHaveURL(url => url.hash === queueHash);
    await page.reload();
    await expect(metric(unscheduledTitle)).toHaveAttribute('aria-pressed', 'true');
    await expect(listItem(unscheduled, repair)).toBeVisible();

    const repairAction = listItem(unscheduled, repair).getByRole('button', { name: `${repair.key} 종료일 입력`, exact: true });
    await repairAction.click();
    await expect(page).toHaveURL(url => url.hash.split('?')[0] === `#/${project.id}/gantt`);
    await expect.poll(() => [hashParameters().get('focusIssue'), hashParameters().get('focusDate')]).toEqual([repair.id, 'endDate']);
    const field = page.getByRole('region', { name: '간트 차트', exact: true }).getByLabel(`${repair.key} 종료일`, { exact: true });
    await expect(field).toBeFocused();
    await expect(field).toBeInViewport({ ratio: 0.9 });
    await expect(field).toHaveValue('');
    await field.fill('2041-04-24');
    const review = page.waitForResponse(response => new URL(response.url()).pathname === '/api/schedule/manual-preview' && response.request().method() === 'POST');
    const apply = page.waitForResponse(response => new URL(response.url()).pathname === '/api/schedule/manual-apply' && response.request().method() === 'POST');
    await field.press('Enter');
    const reviewed = await review;
    expect(reviewed.ok(), await reviewed.text()).toBeTruthy();
    expect(reviewed.request().postDataJSON()).toEqual({ changes: [{
      id: repair.id, expectedVersion: repair.version, startDate: repair.startDate, endDate: '2041-04-24',
    }] });
    const proposal = await reviewed.json() as SchedulePreview;
    expect(proposal.previewId).toBeTruthy();
    const applied = await apply;
    expect(applied.ok(), await applied.text()).toBeTruthy();
    expect(applied.request().postDataJSON()).toEqual({ previewId: proposal.previewId });
    await expect.poll(async () => (await workspace(request)).issues.find(issue => issue.id === repair.id)?.endDate).toBe('2041-04-24');

    await page.goBack();
    await expect(page).toHaveURL(url => url.hash === queueHash);
    await expect(metric(unscheduledTitle)).toHaveAttribute('aria-pressed', 'true');
    await expect(unscheduled.getByRole('listitem')).toHaveCount(2);
    await expect(listItem(unscheduled, repair)).toHaveCount(0);
    await expect(listItem(unscheduled, pending[9])).toBeVisible();
    await expect(listItem(unscheduled, pending[10])).toBeVisible();

    const invalidAddress = new URLSearchParams(queueHash.split('?')[1]);
    invalidAddress.set('teamQueue', 'unrecognized');
    await page.goto(`/${path}?${invalidAddress}`);
    await expect(region('마감 확인')).toBeVisible();
    await expect.poll(() => [hashParameters().get('teamQueue'), hashParameters().get('teamQueueOffset')]).toEqual([null, null]);
  } finally {
    for (const issue of created) await discardIssue(request, issue);
  }
});
