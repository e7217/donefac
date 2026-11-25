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

test('간트에서 날짜 일부를 비운 입력은 마지막 유효값을 유지하고 날짜 전체 지우기는 저장한다', async ({ page, request }) => {
  const { projects: [project] } = await workspace(request);
  const title = `간트 미완성 날짜 입력 ${Date.now()}`;
  const original = { startDate: '2026-11-24', endDate: '2026-11-27' };
  const dates = { startDate: '2026-11-25', endDate: '2026-11-28' };
  const created = await request.post('/api/issues', { data: { projectId: project.id, title, ...original } });
  expect(created.status(), await created.text()).toBe(201);
  const issue = await created.json() as Issue;
  const current = async () => (await workspace(request)).issues.find(value => value.id === issue.id);
  try {
    await page.setViewportSize({ width: 360, height: 760 });
    await page.goto(`/#/${project.id}/gantt`);
    await page.getByLabel('간트 업무 검색', { exact: true }).fill(title, { timeout: 35_000 });
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const start = chart.getByLabel(`${issue.key} 시작일`, { exact: true });
    const end = chart.getByLabel(`${issue.key} 종료일`, { exact: true });
    const save = chart.getByRole('button', { name: `${issue.key} 날짜 저장`, exact: true });
    const requests: unknown[] = [];
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/schedule/manual-preview') {
        requests.push(request.postDataJSON());
      }
    });

    await start.press('Delete');
    await expect(start).toHaveValue('');
    expect(await start.evaluate(input => (input as HTMLInputElement).validity.badInput)).toBe(true);
    await end.press('Enter');
    await expect(start).toBeFocused();
    await expect(start).toHaveAttribute('aria-invalid', 'true');
    expect(requests).toEqual([]);
    expect(await current()).toMatchObject({ ...original, version: issue.version });

    await start.fill(dates.startDate);
    await end.fill(dates.endDate);
    await start.press('Delete');
    await save.click();
    await expect(start).toBeFocused();
    expect(requests).toEqual([]);
    await chart.getByRole('button', { name: `${issue.key} 일정과 연결 편집`, exact: true }).click();
    const editor = page.getByRole('dialog', { name: '업무 일정과 연결 편집', exact: true });
    await expect(editor.getByLabel('시작일', { exact: true })).toHaveValue(dates.startDate);
    await expect(editor.getByLabel('종료일', { exact: true })).toHaveValue(dates.endDate);
    await editor.getByRole('button', { name: '닫기', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(start).toHaveAttribute('aria-invalid', 'true');

    await start.fill(dates.startDate);
    await expect(start).not.toHaveAttribute('aria-invalid', 'true');
    await start.press('Enter');
    await expect.poll(current).toMatchObject({ ...dates, version: issue.version + 1 });
    expect(requests).toEqual([{ changes: [{ id: issue.id, expectedVersion: issue.version, ...dates }] }]);

    await end.focus();
    await start.focus();
    for (const key of ['Delete', 'ArrowRight', 'Delete', 'ArrowRight', 'Delete']) await page.keyboard.press(key);
    await expect(start).toHaveValue('');
    expect(await start.evaluate(input => (input as HTMLInputElement).validity.badInput)).toBe(false);
    await expect(start).not.toHaveAttribute('aria-invalid', 'true');
    await start.press('Enter');
    await expect.poll(current).toMatchObject({ startDate: null, endDate: dates.endDate, version: issue.version + 2 });
    expect(requests.at(-1)).toEqual({ changes: [{ id: issue.id, expectedVersion: issue.version + 1, startDate: null, endDate: dates.endDate }] });
  } finally { await request.delete(`/api/issues/${issue.id}`); }
});

test('360px 간트의 날짜 칸에 붙여넣은 날짜는 저장 전까지 초안으로 유지된다', async ({ page, context, request }) => {
  const { projects: [project] } = await workspace(request);
  const title = `간트 날짜 칸 붙여넣기 ${Date.now()}`;
  const before = { startDate: '2026-11-23', endDate: '2026-11-27' };
  const after = { startDate: '2026-11-24', endDate: '2026-11-28' };
  const created = await request.post('/api/issues', { data: { projectId: project.id, title, ...before } });
  expect(created.status(), await created.text()).toBe(201);
  const issue = await created.json() as Issue;
  const stored = async () => (await workspace(request)).issues.find(value => value.id === issue.id);

  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width: 360, height: 760 });
    await page.goto(`/#/${project.id}/gantt`);
    await page.getByLabel('간트 업무 검색', { exact: true }).fill(title);
    const chart = page.getByRole('region', { name: '간트 차트', exact: true });
    const start = chart.getByLabel(`${issue.key} 시작일`, { exact: true });
    const end = chart.getByLabel(`${issue.key} 종료일`, { exact: true });
    const paste = async (field: Locator, value: string) => {
      await page.evaluate(text => navigator.clipboard.writeText(text), value);
      await field.press('Control+v');
    };

    await paste(start, '2027-02-29');
    await expect(start).toHaveValue(before.startDate);
    await start.press('Delete');
    await expect(start).toHaveAttribute('aria-invalid', 'true');
    await paste(start, ` ${after.startDate} \n`);
    await expect(start).toHaveValue(after.startDate);
    await expect(start).not.toHaveAttribute('aria-invalid', 'true');
    await paste(end, `${after.startDate}\t${after.endDate}`);
    await expect(end).toHaveValue(before.endDate);
    await paste(end, after.endDate);
    await expect(end).toHaveValue(after.endDate);
    expect(await stored()).toMatchObject({ ...before, version: issue.version });

    await end.press('Enter');
    await expect.poll(stored).toMatchObject({ ...after, version: issue.version + 1 });
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    await expect.poll(stored).toMatchObject(before);
  } finally {
    const removed = await request.delete(`/api/issues/${issue.id}`);
    if (removed.ok()) {
      const { trashEntryId } = await removed.json() as { trashEntryId: string };
      if (trashEntryId) await request.delete(`/api/trash/${trashEntryId}`);
    }
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
