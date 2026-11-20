import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { calendarDate, calendarDay } from '../../shared/calendar';
import type {
  Issue, Project, ProjectWorkloadCapacity, TeamWorkloadCapacity, TeamWorkloadLevelPreview, WorkloadLevelPreview, WorkspaceSnapshot,
} from '../../shared/types';
import { formatWorklogMinutes } from '../../src/lib/worklogs';

test.use({ viewport: { width: 360, height: 820 } });

async function readJson<T>(response: Pick<APIResponse, 'status' | 'text' | 'json'>, status = 200): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return response.json() as Promise<T>;
}

async function createProject(request: APIRequestContext, title: string) {
  const key = `WO${randomUUID().slice(0, 8).toUpperCase()}`;
  return readJson<Project>(await request.post('/api/projects', { data: { key, name: `${title} ${key}` } }), 201);
}

async function createIssue(request: APIRequestContext, issues: Issue[], data: Partial<Issue>) {
  const issue = await readJson<Issue>(await request.post('/api/issues', { data }), 201);
  issues.push(issue);
  return issue;
}

async function removeIssues(request: APIRequestContext, issues: Issue[]) {
  for (const issue of issues) {
    const deleted = await request.delete(`/api/issues/${issue.id}`);
    if (deleted.ok()) {
      const { trashEntryId } = await deleted.json() as { trashEntryId: string };
      await request.delete(`/api/trash/${trashEntryId}`);
    }
  }
}

function nextMonday(daysFromToday: number) {
  const day = calendarDay(new Date().toISOString().slice(0, 10)) + daysFromToday;
  const weekday = new Date(`${calendarDate(day)}T00:00:00Z`).getUTCDay();
  return day + (8 - weekday) % 7;
}

const overloadLabel = (date: string, name: string, minutes: number) =>
  `${date} ${name} 초과 ${formatWorklogMinutes(minutes)}`;

test('360px 프로젝트 초과 일정에서 다음 날짜 페이지를 열고 담당자 일정만 조정한다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const { users: [assignee, other] } = await readJson<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const project = await createProject(request, '초과 일정 프로젝트');
  const monday = nextMonday(21);
  const overloadedDate = calendarDate(monday);
  const movedDate = calendarDate(monday + 1);
  const capacityPath = `/api/projects/${project.id}/workload-capacity`;
  const capacity = await readJson<ProjectWorkloadCapacity>(await request.get(capacityPath));
  await readJson<ProjectWorkloadCapacity>(await request.patch(capacityPath, { data: {
    expectedVersion: capacity.version, defaultDailyMinutes: 100, members: [], exceptions: [],
  } }));
  const issues: Issue[] = [];
  const dates = { startDate: overloadedDate, endDate: overloadedDate, projectId: project.id };

  try {
    const fixed = await createIssue(request, issues, {
      ...dates, title: '마감까지 유지할 프로젝트 업무', assigneeId: assignee.id, plannedEffortMinutes: 70, dueDate: overloadedDate, priority: 'high',
    });
    const moving = await createIssue(request, issues, {
      ...dates, title: '다음 근무일에 옮길 프로젝트 업무', assigneeId: assignee.id, plannedEffortMinutes: 65, priority: 'low',
    });
    const unrelated = await createIssue(request, issues, {
      ...dates, title: '다른 담당자의 고정 업무', assigneeId: other.id, plannedEffortMinutes: 125, dueDate: overloadedDate,
    });

    await page.goto(`/#/${project.id}/gantt`);
    await page.getByRole('button', { name: '담당자 작업량', exact: true }).click();
    const workload = page.getByRole('region', { name: '담당자별 업무량', exact: true });
    const overloads = workload.getByRole('region', { name: '초과 일정', exact: true });
    const openOverload = overloads.getByRole('button', { name: overloadLabel(overloadedDate, assignee.name, 35), exact: true });
    const otherOverload = overloads.getByRole('button', { name: overloadLabel(overloadedDate, other.name, 25), exact: true });
    const matrixStart = workload.getByLabel('업무량 시작일', { exact: true });
    const originalStart = (await matrixStart.getAttribute('min'))!;
    const originalEnd = (await matrixStart.getAttribute('max'))!;
    expect(calendarDay(overloadedDate) - calendarDay(originalStart)).toBeGreaterThanOrEqual(14);
    expect(originalEnd > overloadedDate).toBe(true);
    const cell = workload.getByRole('button', { name: `${overloadedDate} ${assignee.name} 업무량`, exact: true });
    const details = workload.getByRole('region', { name: '날짜별 업무 배분', exact: true });
    await expect(cell).toHaveCount(0);
    await expect(overloads.getByRole('button').first()).toHaveAccessibleName(overloadLabel(overloadedDate, assignee.name, 35));

    await openOverload.click();
    await expect(cell).toHaveAttribute('aria-pressed', 'true');
    await expect(openOverload).toHaveAttribute('aria-pressed', 'true');
    await expect(details).toContainText(fixed.key);
    await expect(details).toContainText(moving.key);
    await expect(details).not.toContainText(unrelated.key);
    await details.getByRole('button', { name: '업무 배분 닫기', exact: true }).click();
    await expect(openOverload).toBeFocused();
    await openOverload.click();

    const openPlanner = details.getByRole('button', { name: '이 담당자 일정 조정', exact: true });
    const dialog = page.getByRole('dialog', { name: '과부하 일정 조정', exact: true });
    await openPlanner.click();
    await expect(dialog.getByLabel('조정 대상 담당자', { exact: true })).toHaveValue(assignee.id);
    await expect(dialog).toContainText(`${originalStart} ~ ${originalEnd}`);
    await dialog.getByRole('button', { name: '과부하 일정 조정 닫기', exact: true }).click();
    await expect(openPlanner).toBeFocused();

    await openPlanner.click();
    const previewResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/schedule/workload-preview');
    await dialog.getByRole('button', { name: '과부하 조정 미리보기', exact: true }).click();
    const reply = await previewResponse;
    expect(reply.request().postDataJSON()).toEqual({ projectId: project.id, startDate: originalStart, endDate: originalEnd, userIds: [assignee.id] });
    const preview = await readJson<WorkloadLevelPreview>(reply);
    expect(preview.changes).toMatchObject([{ id: moving.id, toStart: movedDate, toEnd: movedDate }]);
    const applyResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/schedule/workload-apply');
    await dialog.getByRole('button', { name: '과부하 조정 적용', exact: true }).click();
    expect((await applyResponse).ok()).toBe(true);
    await expect(dialog).toBeHidden();
    await expect(openOverload).toHaveCount(0);
    await expect(otherOverload).toBeVisible();
    await expect(cell).toHaveAttribute('data-scheduled-minutes', '70');
    await expect(page.getByLabel(`${moving.key} 시작일`, { exact: true })).toHaveValue(movedDate);
    await expect(page.getByLabel(`${unrelated.key} 시작일`, { exact: true })).toHaveValue(overloadedDate);
  } finally {
    await removeIssues(request, issues);
  }
});

test('360px 프로젝트 간 초과 일정에서 조정할 담당자와 기간·프로젝트 조건을 이어간다', async ({ page, request }) => {
  test.setTimeout(85_000);
  const { users: [, assignee] } = await readJson<WorkspaceSnapshot>(await request.get('/api/workspace'));
  const [fixedProject, movingProject] = await Promise.all([
    createProject(request, '일정 유지 프로젝트'), createProject(request, '일정 이동 프로젝트'),
  ]);
  const monday = nextMonday(35);
  const periodStart = calendarDate(monday);
  const periodEnd = calendarDate(monday + 13);
  const overloadedDate = calendarDate(monday + 2);
  const movedDate = calendarDate(monday + 3);
  const capacityPath = '/api/workload-capacity';
  const { version, defaultDailyMinutes, members, workingWeekdays, calendarExceptions, exceptions } =
    await readJson<TeamWorkloadCapacity>(await request.get(capacityPath));
  const originalCapacity = { defaultDailyMinutes, members, workingWeekdays, calendarExceptions, exceptions };
  const issues: Issue[] = [];
  const dates = { assigneeId: assignee.id, startDate: overloadedDate, endDate: overloadedDate };

  try {
    await readJson<TeamWorkloadCapacity>(await request.patch(capacityPath, { data: {
      ...originalCapacity, expectedVersion: version, workingWeekdays: [1, 2, 3, 4, 5],
      members: [...originalCapacity.members.filter(member => member.userId !== assignee.id), { userId: assignee.id, dailyMinutes: 100 }],
      calendarExceptions: originalCapacity.calendarExceptions.filter(exception => exception.date < periodStart || exception.date > periodEnd),
      exceptions: originalCapacity.exceptions.filter(exception => exception.userId !== assignee.id || exception.date < periodStart || exception.date > periodEnd),
    } }));
    const fixed = await createIssue(request, issues, {
      ...dates, projectId: fixedProject.id, title: '다른 프로젝트의 당일 마감 업무', plannedEffortMinutes: 70, dueDate: overloadedDate, priority: 'high',
    });
    const moving = await createIssue(request, issues, {
      ...dates, projectId: movingProject.id, title: '팀 일정에서 옮길 업무', plannedEffortMinutes: 65, priority: 'low',
    });

    await page.goto(`/#/${movingProject.id}/gantt`);
    await page.getByRole('button', { name: '프로젝트 간 작업량', exact: true }).click();
    const workload = page.getByRole('region', { name: '프로젝트 간 작업량', exact: true });
    await workload.getByLabel('프로젝트 간 작업량 시작일', { exact: true }).fill(periodStart);
    await workload.getByText('프로젝트 선택', { exact: true }).click();
    await workload.getByRole('button', { name: '전체 해제', exact: true }).click();
    await workload.getByRole('checkbox', { name: movingProject.name, exact: true }).check();
    await workload.getByRole('checkbox', { name: fixedProject.name, exact: true }).check();
    await expect(workload.getByRole('combobox', { name: '담당자 필터', exact: true })).toHaveValue('');
    const overloads = workload.getByRole('region', { name: '초과 일정', exact: true });
    await overloads.getByRole('button', { name: overloadLabel(overloadedDate, assignee.name, 35), exact: true }).click();
    const details = workload.getByRole('region', { name: '프로젝트별 업무 배분', exact: true });
    await expect(details).toContainText(fixed.key);
    await expect(details).toContainText(moving.key);
    const openPlanner = details.getByRole('button', { name: '이 담당자 일정 조정', exact: true });
    await openPlanner.click();

    const dialog = page.getByRole('dialog', { name: '프로젝트 간 과부하 조정', exact: true });
    await expect(dialog.getByLabel('조정 대상 담당자', { exact: true })).toHaveValue(assignee.id);
    await expect(dialog).toContainText(`${periodStart} ~ ${periodEnd}`);
    const projects = dialog.locator('details').filter({ hasText: '이동할 프로젝트' });
    await expect(projects.locator('li')).toHaveCount(2);
    await expect(projects).toContainText(fixedProject.name);
    await expect(projects).toContainText(movingProject.name);
    const previewResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/schedule/team-workload-preview');
    await dialog.getByRole('button', { name: '과부하 조정 미리보기', exact: true }).click();
    const reply = await previewResponse;
    expect(reply.request().postDataJSON()).toEqual({
      projectIds: expect.arrayContaining([fixedProject.id, movingProject.id]),
      startDate: periodStart, endDate: periodEnd, userIds: [assignee.id],
    });
    expect(reply.request().postDataJSON().projectIds).toHaveLength(2);
    const preview = await readJson<TeamWorkloadLevelPreview>(reply);
    expect(preview.before.excessMinutes).toBe(35);
    expect(preview.after.excessMinutes).toBe(0);
    expect(preview.changes).toMatchObject([{ id: moving.id, projectId: movingProject.id, toStart: movedDate, toEnd: movedDate }]);
    const applyResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/schedule/team-workload-apply');
    await dialog.getByRole('button', { name: '과부하 조정 적용', exact: true }).click();
    expect((await applyResponse).ok()).toBe(true);
    await expect(dialog).toBeHidden();
    await expect(overloads).toHaveCount(0);
    const cell = (date: string) => workload.getByRole('button', { name: `${date} ${assignee.name} 업무량`, exact: true });
    await expect(cell(overloadedDate)).toHaveAttribute('data-scheduled-minutes', '70');
    await expect(cell(movedDate)).toHaveAttribute('data-scheduled-minutes', '65');
    await expect(workload.getByLabel('프로젝트 간 작업량 시작일', { exact: true })).toHaveValue(periodStart);
  } finally {
    try { await removeIssues(request, issues); }
    finally {
      const current = await readJson<TeamWorkloadCapacity>(await request.get(capacityPath));
      if (current.version !== version) {
        await readJson<TeamWorkloadCapacity>(await request.patch(capacityPath, {
          data: { ...originalCapacity, expectedVersion: current.version },
        }));
      }
    }
  }
});
