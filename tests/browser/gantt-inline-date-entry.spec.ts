import { expect, test, type APIRequestContext, type Locator } from '@playwright/test';
import type { Issue, WorkspaceSnapshot } from '../../shared/types';

async function workspace(request: APIRequestContext) {
  const response = await request.get('/api/workspace');
  expect(response.ok()).toBeTruthy();
  return await response.json() as WorkspaceSnapshot;
}

async function expectVisibleFocus(field: Locator) {
  await expect(field).toBeFocused();
  await expect(field).toBeInViewport({ ratio: 0.95 });
  expect(await field.evaluate(input => {
    const { x, y, width, height } = input.getBoundingClientRect();
    return document.elementFromPoint(x + width / 2, y + height / 2) === input;
  })).toBe(true);
}

test('360px 간트의 날짜 입력은 업무 상세를 열지 않고 행에서 누락된 날짜를 입력하고 되돌린다', async ({ page, request }) => {
  const { projects: [project] } = await workspace(request);
  const title = `간트 행 날짜 입력 ${Date.now()}`;
  const startDate = '2026-11-23', endDate = '2026-11-27';
  const created: Issue[] = [];
  try {
    for (const [label, dates] of [['미정', {}], ['시작일 있음', { startDate }], ['종료일 있음', { endDate }]] as const) {
      const response = await request.post('/api/issues', { data: { projectId: project.id, title: `${title} ${label}`, ...dates } });
      expect(response.ok()).toBeTruthy();
      created.push(await response.json() as Issue);
    }
    const [unscheduled, hasStart, hasEnd] = created;
    const stored = async (id: string) => (await workspace(request)).issues.find(issue => issue.id === id);
    await page.setViewportSize({ width: 360, height: 760 });
    await page.goto(`/#/${project.id}/gantt`);
    await page.getByLabel('간트 업무 검색', { exact: true }).fill(title);
    const chart = page.getByRole('region', { name: '간트 차트' });
    const start = (issue: Issue) => chart.getByLabel(`${issue.key} 시작일`, { exact: true });
    const end = (issue: Issue) => chart.getByLabel(`${issue.key} 종료일`, { exact: true });
    const pendingRow = (issue: Issue) => page.locator('.gantt-unscheduled-row').filter({ hasText: issue.title });
    const chartAction = (issue: Issue) => chart.getByRole('button', { name: `${issue.key} 날짜 입력`, exact: true });
    const listAction = (issue: Issue) => pendingRow(issue).getByRole('button', { name: `${issue.key} 날짜 입력`, exact: true });

    await listAction(unscheduled).click();
    await expectVisibleFocus(start(unscheduled));
    await expect(start(unscheduled)).toHaveValue('');
    await expect(end(unscheduled)).toHaveValue('');
    await start(unscheduled).fill(startDate);
    await end(unscheduled).focus();
    expect((await stored(unscheduled.id))?.version).toBe(unscheduled.version);
    await end(unscheduled).fill(endDate);
    await end(unscheduled).press('Enter');
    await expect.poll(() => stored(unscheduled.id)).toMatchObject({ startDate, endDate });
    await expect(pendingRow(unscheduled)).toHaveCount(0);

    await chartAction(hasStart).click();
    await expectVisibleFocus(end(hasStart));
    await expect(start(hasStart)).toHaveValue(startDate);
    await expect(end(hasStart)).toHaveValue('');
    await end(hasStart).fill(endDate);
    await end(hasStart).press('Enter');
    await expect.poll(() => stored(hasStart.id)).toMatchObject({ startDate, endDate });
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    await expect.poll(() => stored(hasStart.id)).toMatchObject({ startDate, endDate: null });

    await expect(chartAction(hasEnd)).toBeEnabled();
    await chartAction(hasEnd).press('Enter');
    await expectVisibleFocus(start(hasEnd));
    await expect(end(hasEnd)).toHaveValue(endDate);
    await expect(page).toHaveURL(new RegExp(`/#/${project.id}/gantt$`));
    await expect(page.locator('.issue-detail-panel')).toHaveCount(0);
    await pendingRow(hasEnd).getByRole('button', { name: new RegExp(hasEnd.title) }).click();
    await expect(page.locator('.issue-detail-panel')).toBeVisible();
  } finally {
    for (const issue of created) await request.delete(`/api/issues/${issue.id}`);
  }
});
