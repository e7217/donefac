import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { calendarDate, calendarDay } from '../../shared/calendar';
import type { Issue, Project, ProjectWorkloadCapacity, WorkloadLevelPreview, WorkspaceSnapshot } from '../../shared/types';

test('360px에서 과부하 조정안을 검토하고 적용 결과를 복구한 뒤 되돌린다', async ({ page, request }) => {
  const key = `WL${randomUUID().slice(0, 8).toUpperCase()}`;
  const [assignee, secondAssignee] = ((await (await request.get('/api/workspace')).json()) as WorkspaceSnapshot).users;
  const projectResponse = await request.post('/api/projects', { data: { key, name: `과부하 조정 ${key}` } });
  expect(projectResponse.status(), await projectResponse.text()).toBe(201);
  const project = await projectResponse.json() as Project;
  const today = calendarDay(new Date().toISOString().slice(0, 10));
  const monday = today + ((8 - new Date(today * 86_400_000).getUTCDay()) % 7 || 7);
  const firstDay = calendarDate(monday);
  const unavailableDay = calendarDate(monday + 1);
  const movedDay = calendarDate(monday + 2);
  const capacityRoute = `/api/projects/${project.id}/workload-capacity`;
  const capacity = await (await request.get(capacityRoute)).json() as ProjectWorkloadCapacity;
  const capacityResponse = await request.patch(capacityRoute, { data: {
    expectedVersion: capacity.version, defaultDailyMinutes: 100,
    members: [{ userId: secondAssignee.id, dailyMinutes: 160 }],
    exceptions: [
      { userId: assignee.id, date: unavailableDay, availableMinutes: 0 },
      { userId: secondAssignee.id, date: firstDay, availableMinutes: 100 },
    ],
  } });
  expect(capacityResponse.ok(), await capacityResponse.text()).toBe(true);

  const issues: Issue[] = [];
  async function createIssue(title: string, values: Partial<Issue>) {
    const response = await request.post('/api/issues', { data: {
      projectId: project.id, title, assigneeId: assignee.id, startDate: firstDay, endDate: firstDay, plannedEffortMinutes: 60, ...values,
    } });
    expect(response.status(), await response.text()).toBe(201);
    const issue = await response.json() as Issue;
    issues.push(issue);
    return issue;
  }
  async function currentIssues() {
    const snapshot = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
    return snapshot.issues.filter(issue => issue.projectId === project.id);
  }

  try {
    const high = await createIssue('우선으로 유지할 업무', { priority: 'high' });
    const low = await createIssue('조정할 낮은 우선순위 업무', { priority: 'low' });
    const fixed = await createIssue('당일 마감이라 과부하가 남는 업무', {
      assigneeId: secondAssignee.id, plannedEffortMinutes: 150, dueDate: firstDay,
    });
    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${project.id}/gantt`);
    await page.getByRole('checkbox', { name: `${low.key} 선택`, exact: true }).check();
    await page.getByRole('button', { name: '담당자 작업량', exact: true }).click();
    const workload = page.getByRole('region', { name: '담당자별 업무량', exact: true });
    await workload.getByLabel('업무량 시작일', { exact: true }).fill(firstDay);
    const firstCell = workload.getByRole('button', { name: `${firstDay} ${assignee.name} 업무량`, exact: true });
    const movedCell = workload.getByRole('button', { name: `${movedDay} ${assignee.name} 업무량`, exact: true });
    const unavailableCell = workload.getByRole('button', { name: `${unavailableDay} ${assignee.name} 업무량`, exact: true });
    await expect(firstCell).toHaveAttribute('data-scheduled-minutes', '120');
    await expect(unavailableCell).toHaveAttribute('data-available-minutes', '0');
    await expect(movedCell).toHaveAttribute('data-scheduled-minutes', '0');
    await workload.getByRole('button', { name: '과부하 일정 조정', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: '과부하 일정 조정', exact: true });
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    const selectedOnly = dialog.getByRole('checkbox', { name: /간트에서 선택한 업무만 이동/ });
    await expect(selectedOnly).not.toBeChecked();
    await selectedOnly.check();
    const previewResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/schedule/workload-preview');
    await dialog.getByRole('button', { name: '과부하 조정 미리보기', exact: true }).click();
    const reply = await previewResponse;
    expect(reply.status(), await reply.text()).toBe(200);
    expect(reply.request().postDataJSON()).toMatchObject({ projectId: project.id, issueIds: [low.id] });
    const proposal = await reply.json() as WorkloadLevelPreview;
    expect(proposal.before).toMatchObject({ overloadedCells: 2, excessMinutes: 70, completionDate: firstDay });
    expect(proposal.after).toMatchObject({ overloadedCells: 1, excessMinutes: 50, completionDate: movedDay });
    expect(proposal.changes).toMatchObject([{
      id: low.id, fromStart: firstDay, fromEnd: firstDay, toStart: movedDay, toEnd: movedDay,
    }]);
    expect(proposal.remaining).toEqual([{ userId: secondAssignee.id, date: firstDay, excessMinutes: 50, issueIds: [fixed.id] }]);
    const summary = dialog.getByRole('region', { name: '조정 전후 작업량', exact: true });
    await expect(summary).toContainText(/2\s*→\s*1/);
    await expect(summary).toContainText(movedDay);
    await expect(dialog.getByRole('region', { name: '남은 과부하', exact: true })).toContainText(fixed.key);
    await expect(dialog.getByText(low.key, { exact: false })).toBeVisible();
    expect((await currentIssues()).find(issue => issue.id === low.id)).toEqual(low);

    const applyAttempts: string[] = [];
    await page.route('**/api/schedule/workload-apply', async route => {
      applyAttempts.push(route.request().postDataJSON().previewId);
      const committed = await route.fetch();
      if (committed.ok()) await route.fulfill({ status: 502, json: { error: '합성 적용 응답 유실' } });
      else await route.fulfill({ response: committed });
    });
    await page.route('**/api/workspace', route => route.fulfill({ status: 502, json: { error: '합성 화면 갱신 실패' } }), { times: 1 });
    const confirmation = page.waitForResponse(response => new URL(response.url()).pathname === `/api/schedule/workload-result/${proposal.previewId}`);
    await dialog.getByRole('button', { name: '과부하 조정 적용', exact: true }).click();
    const receipt = await confirmation;
    expect(receipt.status(), await receipt.text()).toBe(200);
    await expect(dialog.getByRole('alert')).toContainText('일정이 적용되었습니다. 화면 갱신을 다시 시도해 주세요.');
    await dialog.getByRole('button', { name: '화면 다시 불러오기', exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(applyAttempts).toEqual([proposal.previewId]);
    await expect(firstCell).toHaveAttribute('data-scheduled-minutes', '60');
    await expect(movedCell).toHaveAttribute('data-scheduled-minutes', '60');
    await expect(page.getByLabel(`${low.key} 시작일`, { exact: true })).toHaveValue(movedDay);
    const applied = await currentIssues();
    expect(applied.find(issue => issue.id === low.id)).toMatchObject({ startDate: movedDay, endDate: movedDay, version: low.version + 1 });
    expect(applied.find(issue => issue.id === high.id)).toEqual(high);
    expect(applied.find(issue => issue.id === fixed.id)).toEqual(fixed);

    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    await expect(firstCell).toHaveAttribute('data-scheduled-minutes', '120');
    await expect(movedCell).toHaveAttribute('data-scheduled-minutes', '0');
    expect((await currentIssues()).find(issue => issue.id === low.id)).toMatchObject({ startDate: firstDay, endDate: firstDay, version: low.version + 2 });
  } finally {
    for (const issue of issues) {
      const response = await request.delete(`/api/issues/${issue.id}`);
      if (response.ok()) await request.delete(`/api/trash/${(await response.json()).trashEntryId}`);
    }
  }
});
