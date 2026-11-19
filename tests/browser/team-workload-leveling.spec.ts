import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { calendarDate, calendarDay } from '../../shared/calendar';
import type { Issue, Project, TeamWorkloadCapacity, TeamWorkloadLevelPreview, WorkCalendar, WorkspaceSnapshot } from '../../shared/types';

const capacityPath = '/api/workload-capacity';

function capacityDraft({ defaultDailyMinutes, members, exceptions, workingWeekdays, calendarExceptions }: TeamWorkloadCapacity) {
  return { defaultDailyMinutes, members, exceptions, workingWeekdays, calendarExceptions };
}

test('360px에서 여러 프로젝트의 과부하를 계산하고 선택한 프로젝트만 조정한 뒤 되돌린다', async ({ page, request }) => {
  async function workspace() {
    const response = await request.get('/api/workspace');
    expect(response.ok(), await response.text()).toBe(true);
    return response.json() as Promise<WorkspaceSnapshot>;
  }

  async function teamCapacity() {
    const response = await request.get(capacityPath);
    expect(response.ok(), await response.text()).toBe(true);
    return response.json() as Promise<TeamWorkloadCapacity>;
  }

  async function createProject(prefix: string, title: string, workingWeekdays: number[]) {
    const key = `${prefix}${randomUUID().slice(0, 8).toUpperCase()}`;
    const response = await request.post('/api/projects', { data: { key, name: `${title} ${key}` } });
    expect(response.status(), await response.text()).toBe(201);
    const project = await response.json() as Project;
    const path = `/api/projects/${project.id}/calendar`;
    const calendarResponse = await request.get(path);
    expect(calendarResponse.ok(), await calendarResponse.text()).toBe(true);
    const calendar = await calendarResponse.json() as WorkCalendar;
    const changed = await request.patch(path, { data: { expectedVersion: calendar.version, workingWeekdays } });
    expect(changed.ok(), await changed.text()).toBe(true);
    return project;
  }

  const [assignee] = (await workspace()).users;
  const initialCapacity = await teamCapacity();
  const future = calendarDay(new Date().toISOString().slice(0, 10)) + 56;
  const firstMonday = future + ((8 - new Date(future * 86_400_000).getUTCDay()) % 7);
  const monday = calendarDate(firstMonday);
  const tuesday = calendarDate(firstMonday + 1);
  const wednesday = calendarDate(firstMonday + 2);
  const thursday = calendarDate(firstMonday + 3);
  const endDate = calendarDate(firstMonday + 13);
  const issues: Issue[] = [];

  async function createIssue(project: Project, title: string, effort: number, priority: Issue['priority']) {
    const response = await request.post('/api/issues', { data: {
      projectId: project.id, title, assigneeId: assignee.id, priority, startDate: monday, endDate: monday, plannedEffortMinutes: effort,
    } });
    expect(response.status(), await response.text()).toBe(201);
    const issue = await response.json() as Issue;
    issues.push(issue);
    return issue;
  }

  try {
    const [movingProject, backgroundProject] = await Promise.all([
      createProject('MV', '조정 대상 프로젝트', [1, 3, 4]),
      createProject('FX', '배경 프로젝트', [1, 2]),
    ]);
    const updated = await request.patch(capacityPath, { data: {
      ...capacityDraft(initialCapacity), expectedVersion: initialCapacity.version, workingWeekdays: [1, 2, 3, 4, 5],
      members: [...initialCapacity.members.filter(member => member.userId !== assignee.id), { userId: assignee.id, dailyMinutes: 100 }],
      calendarExceptions: initialCapacity.calendarExceptions.filter(exception => exception.date < monday || exception.date > endDate),
      exceptions: [
        ...initialCapacity.exceptions.filter(exception => exception.userId !== assignee.id || exception.date < monday || exception.date > endDate),
        { userId: assignee.id, date: wednesday, availableMinutes: 0 },
      ],
    } });
    expect(updated.ok(), await updated.text()).toBe(true);
    const fixed = await createIssue(backgroundProject, '기존 날짜에 남기는 프로젝트 업무', 70, 'low');
    const moving = await createIssue(movingProject, '팀 가용 시간에 맞춰 옮길 업무', 65, 'low');

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${movingProject.id}/gantt`);
    await page.getByRole('button', { name: '프로젝트 간 작업량', exact: true }).click();
    const team = page.getByRole('region', { name: '프로젝트 간 작업량', exact: true });
    await team.getByLabel('프로젝트 간 작업량 시작일', { exact: true }).fill(monday);
    await team.getByRole('combobox', { name: '담당자 필터', exact: true }).selectOption(assignee.id);
    const cell = (date: string) => team.getByRole('button', { name: `${date} ${assignee.name} 업무량`, exact: true });
    await expect(cell(monday)).toHaveAttribute('data-scheduled-minutes', '135');
    await expect(cell(monday)).toHaveAttribute('data-available-minutes', '100');
    await expect(cell(monday)).toHaveClass(/is-overloaded/u);
    await expect(cell(tuesday)).toHaveAttribute('data-available-minutes', '100');
    await expect(cell(wednesday)).toHaveAttribute('data-available-minutes', '0');

    await team.getByText('프로젝트 선택', { exact: true }).click();
    await team.getByRole('button', { name: '전체 해제', exact: true }).click();
    await team.getByRole('checkbox', { name: movingProject.name, exact: true }).check();
    await expect(cell(monday)).toHaveAttribute('data-scheduled-minutes', '65');
    await expect(cell(monday)).not.toHaveClass(/is-overloaded/u);
    await team.getByRole('button', { name: '프로젝트 간 과부하 조정', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: '프로젝트 간 과부하 조정', exact: true });
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    await expect(dialog.getByLabel('조정 대상 담당자', { exact: true })).toHaveValue(assignee.id);
    const scope = dialog.locator('details').filter({ hasText: '이동할 프로젝트' });
    await expect(scope).toContainText(movingProject.name);
    await expect(scope).not.toContainText(backgroundProject.name);
    const previewResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/schedule/team-workload-preview');
    await dialog.getByRole('button', { name: '과부하 조정 미리보기', exact: true }).click();
    const reply = await previewResponse;
    expect(reply.status(), await reply.text()).toBe(200);
    expect(reply.request().postDataJSON()).toEqual({ startDate: monday, endDate, projectIds: [movingProject.id], userIds: [assignee.id] });
    const preview = await reply.json() as TeamWorkloadLevelPreview;
    expect(preview.before).toMatchObject({ overloadedCells: 1, excessMinutes: 35 });
    expect(preview.after).toMatchObject({ overloadedCells: 0, excessMinutes: 0 });
    expect(preview.movableProjectIds).toEqual([movingProject.id]);
    expect(preview.changes).toHaveLength(1);
    expect(preview.changes[0]).toMatchObject({
      id: moving.id, projectId: movingProject.id, fromStart: monday, fromEnd: monday, toStart: thursday, toEnd: thursday,
    });
    expect(preview.projectCompletions).toEqual([{ projectId: movingProject.id, before: monday, after: thursday }]);
    const summary = dialog.getByRole('region', { name: '조정 전후 작업량', exact: true });
    await expect(summary).toContainText(/1\s*→\s*0/u);
    const dates = dialog.getByRole('table', { name: '프로젝트별 계획 종료일', exact: true });
    const changedProject = dates.getByRole('row').filter({ hasText: movingProject.name });
    await expect(changedProject).toContainText(monday);
    await expect(changedProject).toContainText(thursday);
    expect((await workspace()).issues.find(issue => issue.id === moving.id)).toEqual(moving);

    const applyAttempts: string[] = [];
    await page.route('**/api/schedule/team-workload-apply', async route => {
      applyAttempts.push(route.request().postDataJSON().previewId);
      const applied = await route.fetch();
      if (applied.ok()) await route.fulfill({ status: 502, json: { error: '합성 적용 응답 유실' } });
      else await route.fulfill({ response: applied });
    });
    const received = page.waitForResponse(response => new URL(response.url()).pathname === `/api/schedule/team-workload-result/${preview.previewId}`);
    await dialog.getByRole('button', { name: '과부하 조정 적용', exact: true }).click();
    const receipt = await received;
    expect(receipt.ok(), await receipt.text()).toBe(true);
    await expect(dialog).toBeHidden();
    expect(applyAttempts).toEqual([preview.previewId]);
    await expect(cell(monday)).toHaveAttribute('data-scheduled-minutes', '0');
    await expect(cell(thursday)).toHaveAttribute('data-scheduled-minutes', '65');
    const applied = (await workspace()).issues;
    expect(applied.find(issue => issue.id === moving.id)).toMatchObject({ startDate: thursday, endDate: thursday, version: moving.version + 1 });
    expect(applied.find(issue => issue.id === fixed.id)).toEqual(fixed);

    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    await expect(cell(monday)).toHaveAttribute('data-scheduled-minutes', '65');
    await expect(cell(thursday)).toHaveAttribute('data-scheduled-minutes', '0');
    expect((await workspace()).issues.find(issue => issue.id === moving.id)).toMatchObject({ startDate: monday, endDate: monday, version: moving.version + 2 });
  } finally {
    try {
      for (const issue of issues) {
        const response = await request.delete(`/api/issues/${issue.id}`);
        expect(response.ok(), await response.text()).toBe(true);
        const { trashEntryId } = await response.json() as { trashEntryId: string };
        expect((await request.delete(`/api/trash/${trashEntryId}`)).ok()).toBe(true);
      }
    } finally {
      const latest = await teamCapacity();
      if (latest.version !== initialCapacity.version) {
        const restored = await request.patch(capacityPath, { data: { ...capacityDraft(initialCapacity), expectedVersion: latest.version } });
        expect(restored.ok(), await restored.text()).toBe(true);
      }
    }
  }
});
