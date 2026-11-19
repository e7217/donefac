import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Issue, PlanningItem, PlanScheduleShiftPreview, PlanScheduleShiftResult, Project, WorkspaceSnapshot } from '../../shared/types';

const today = Date.now();
const day = (offset: number) => new Date(today + offset * 86_400_000).toISOString().slice(0, 10);

test('360px에서 계획과 연결 업무를 미리 보고 적용 응답을 복구한 뒤 함께 되돌린다', async ({ page, request }) => {
  const key = `PS${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;
  const projectResponse = await request.post('/api/projects', { data: { key, name: `계획 이동 ${key}` } });
  expect(projectResponse.status()).toBe(201);
  const project = await projectResponse.json() as Project;
  const beforePlanDates = { startDate: day(0), endDate: day(6), targetDate: day(7) };
  const planResponse = await request.post('/api/planning-items', { data: { projectId: project.id, kind: 'cycle', name: `이동 사이클 ${key}`, ...beforePlanDates } });
  expect(planResponse.status(), await planResponse.text()).toBe(201);
  const plan = await planResponse.json() as PlanningItem;
  const issues: Issue[] = [];
  async function createIssue(name: string, values: Partial<Issue>) {
    const response = await request.post('/api/issues', { data: { projectId: project.id, title: name, cycleId: plan.id, ...values } });
    expect(response.status(), await response.text()).toBe(201);
    const issue = await response.json() as Issue;
    issues.push(issue);
    return issue;
  }
  async function snapshot() {
    return await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  }

  try {
    const moving = await createIssue(`옮길 업무 ${key}`, { startDate: day(1), endDate: day(3) });
    const completed = await createIssue(`완료된 업무 ${key}`, { status: 'done', startDate: day(1), endDate: day(2) });
    const unscheduled = await createIssue(`날짜 미정 업무 ${key}`, {});
    const outside = await createIssue(`다른 업무 ${key}`, { cycleId: null, startDate: day(4), endDate: day(7) });
    expect((await request.post('/api/dependencies', { data: { predecessorId: moving.id, successorId: outside.id } })).status()).toBe(201);

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${project.id}/gantt/${plan.id}`);
    const open = page.getByRole('button', { name: '계획 일정 함께 이동', exact: true });
    await open.click();
    const dialog = page.getByRole('dialog', { name: '계획 일정 함께 이동', exact: true });
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360);
    const days = dialog.getByLabel('계획 이동 일수', { exact: true });
    expect(await days.inputValue()).toBe('5');
    await days.fill('3');
    await expect(dialog.getByLabel('연결된 업무도 함께 이동', { exact: true })).toBeChecked();
    await expect(dialog.getByLabel('계획 이동에 근무일 사용', { exact: true })).not.toBeChecked();
    const previewResponse = page.waitForResponse(response => response.url().endsWith(`/planning-items/${plan.id}/schedule-preview`));
    await dialog.getByRole('button', { name: '계획 이동 미리보기', exact: true }).click();
    const previewReply = await previewResponse;
    expect(previewReply.status(), await previewReply.text()).toBe(200);
    const preview = await previewReply.json() as PlanScheduleShiftPreview;
    const movedPlanDates = { startDate: day(3), endDate: day(9), targetDate: day(10) };
    expect(preview.plan).toMatchObject({ id: plan.id, from: beforePlanDates, to: movedPlanDates });
    expect(preview.changes).toMatchObject([{ id: moving.id, toStart: day(4), toEnd: day(6) }]);
    expect(preview.skipped.map(item => [item.id, item.reason])).toEqual(expect.arrayContaining([[completed.id, 'terminal'], [unscheduled.id, 'unscheduled']]));
    expect(preview.warnings.some(warning => warning.includes(outside.key))).toBe(true);
    await expect(dialog).toContainText(day(10));
    await expect(dialog).toContainText(moving.key);
    const beforeApply = await snapshot();
    expect(beforeApply.planningItems!.find(item => item.id === plan.id)).toMatchObject(beforePlanDates);
    expect(beforeApply.issues.find(issue => issue.id === moving.id)!.version).toBe(moving.version);

    let attempts = 0;
    let committed: PlanScheduleShiftResult | undefined;
    await page.route(`**/planning-items/${plan.id}/schedule-apply`, async route => {
      attempts++;
      const response = await route.fetch();
      if (attempts === 1 && response.ok()) {
        committed = await response.json() as PlanScheduleShiftResult;
        await route.abort('failed');
      } else await route.fulfill({ response });
    });
    await dialog.getByRole('button', { name: '계획 이동 적용', exact: true }).click();
    const recover = dialog.getByRole('button', { name: '계획 이동 적용 결과 다시 확인', exact: true });
    await expect(recover).toBeVisible();
    await expect(days).toBeDisabled();
    expect(committed?.plan).toMatchObject(movedPlanDates);
    expect(committed?.updated).toMatchObject([{ id: moving.id, startDate: day(4), endDate: day(6), version: moving.version + 1 }]);
    await recover.click();
    await expect(dialog).toBeHidden();
    expect(attempts).toBe(2);
    const applied = await snapshot();
    expect(applied.planningItems!.find(item => item.id === plan.id)).toMatchObject({ ...movedPlanDates, version: plan.version + 1 });
    expect(applied.issues.find(item => item.id === moving.id)!.version).toBe(moving.version + 1);

    const undoResponse = page.waitForResponse(response => response.url().endsWith('/api/schedule/undo'));
    await page.locator('button[title="마지막 일정 변경 되돌리기"]').click();
    const undone = await undoResponse;
    expect(undone.status(), await undone.text()).toBe(200);
    expect(await undone.json()).toMatchObject({ plan: beforePlanDates, updated: [{ id: moving.id, startDate: moving.startDate, endDate: moving.endDate }] });
    const current = await snapshot();
    expect(current.planningItems!.find(item => item.id === plan.id)).toMatchObject({ ...beforePlanDates, version: plan.version + 2 });
    for (const issue of [completed, unscheduled, outside]) expect(current.issues.find(item => item.id === issue.id)).toEqual(issue);
  } finally {
    for (const issue of issues) await request.delete(`/api/issues/${issue.id}`);
    const current = (await snapshot()).planningItems?.find(item => item.id === plan.id);
    if (current) await request.delete(`/api/planning-items/${plan.id}?expectedVersion=${current.version}`);
  }
});
