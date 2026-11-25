import { expect, test, type APIRequestContext, type Dialog, type Locator } from '@playwright/test';
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
    await chartAction(unscheduled).click();
    await expectVisibleFocus(end(unscheduled));
    const acceptReload = (dialog: Dialog) => { void dialog.accept(); };
    page.on('dialog', acceptReload);
    try { await page.reload(); }
    finally { page.off('dialog', acceptReload); }
    await page.getByLabel('간트 업무 검색', { exact: true }).fill(title);
    await listAction(unscheduled).click();
    await expectVisibleFocus(end(unscheduled));
    await expect(start(unscheduled)).toHaveValue(startDate);
    expect((await stored(unscheduled.id))?.version).toBe(unscheduled.version);
    await end(unscheduled).fill(endDate);
    await end(unscheduled).press('Enter');
    await expect.poll(() => stored(unscheduled.id)).toMatchObject({ startDate, endDate });
    await expect(pendingRow(unscheduled)).toHaveCount(0);

    await chartAction(hasStart).click();
    await expectVisibleFocus(end(hasStart));
    await expect(start(hasStart)).toHaveValue(startDate);
    await expect(end(hasStart)).toHaveValue('');
    await start(hasStart).fill('');
    await listAction(hasStart).click();
    await expectVisibleFocus(start(hasStart));
    await start(hasStart).press('Escape');
    await expect(start(hasStart)).toHaveValue(startDate);
    await chartAction(hasStart).click();
    await expectVisibleFocus(end(hasStart));
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

test('간트 날짜 초안을 저장하지 않고 유지하거나 확인 후 전체 프로젝트 보드로 이동한다', async ({ page, request }) => {
  const { projects: [project] } = await workspace(request);
  const title = `팀 보드 이동 전 간트 날짜 입력 ${Date.now()}`;
  const response = await request.post('/api/issues', { data: { projectId: project.id, title } });
  expect(response.ok()).toBeTruthy();
  const issue = await response.json() as Issue;
  const stored = async () => (await workspace(request)).issues.find(value => value.id === issue.id);
  try {
    await page.goto(`/#/${project.id}/gantt`);
    await page.getByLabel('간트 업무 검색', { exact: true }).fill(title);
    await page.locator('.gantt-unscheduled-row').getByRole('button', { name: `${issue.key} 날짜 입력`, exact: true }).click();
    const date = page.getByRole('region', { name: '간트 차트' }).getByLabel(`${issue.key} 시작일`, { exact: true });
    await date.fill('2026-11-23');
    const teamBoard = page.getByRole('button', { name: '전체 프로젝트 보드', exact: true });
    async function navigate(accept: boolean) {
      const handled = page.waitForEvent('dialog', { timeout: 5_000 }).then(async dialog => {
        const message = dialog.message();
        if (accept) await dialog.accept();
        else await dialog.dismiss();
        expect(message).toContain('저장하지 않은 간트 입력');
      });
      await Promise.all([handled, teamBoard.click()]);
    }
    await navigate(false);
    await expect(date).toHaveValue('2026-11-23');
    await expect(date).toBeFocused();
    expect(await stored()).toMatchObject({ startDate: null, version: issue.version });

    await navigate(true);
    await expect(page.getByRole('heading', { name: '전체 프로젝트 보드', exact: true })).toBeVisible();
    expect(await stored()).toMatchObject({ startDate: null, version: issue.version });
  } finally {
    const removed = await request.delete(`/api/issues/${issue.id}`);
    if (removed.ok()) {
      const { trashEntryId } = await removed.json() as { trashEntryId: string };
      await request.delete(`/api/trash/${trashEntryId}`);
    }
  }
});
