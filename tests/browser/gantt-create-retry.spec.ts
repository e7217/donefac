import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { Issue, WorkspaceSnapshot } from '../../shared/types';

const dateIn = (days: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

async function workspace(request: APIRequestContext) {
  const response = await request.get('/api/workspace');
  expect(response.ok(), await response.text()).toBeTruthy();
  return await response.json() as WorkspaceSnapshot;
}

for (const { removed, description } of [
  { removed: false, description: '간트에서 응답과 목록 조회가 끊겨도 같은 날짜와 업무를 다시 확인한다' },
  { removed: true, description: '간트에서 이미 추가한 업무가 삭제되면 다시 확인해도 업무가 생기지 않는다' },
]) {
  test(description, async ({ page, request }) => {
    await page.setViewportSize({ width: 360, height: 820 });
    const initial = await workspace(request);
    const project = initial.projects[0];
    const title = `간트 업무 추가 확인 ${randomUUID()}`;
    const startDate = dateIn(1);
    const endDate = dateIn(4);
    const attempts: { payload: string | null; actor: string | undefined; status: number }[] = [];
    let failRefresh = false;

    try {
      await page.goto(`/#/${project.id}/gantt`);
      const add = page.getByRole('button', { name: '업무 추가', exact: true });
      await add.click();
      const form = page.getByRole('form', { name: '간트에서 업무 만들기' });
      const titleInput = form.getByLabel('추가할 업무 제목', { exact: true });
      const start = form.getByLabel('추가할 업무 시작일', { exact: true });
      const end = form.getByLabel('추가할 업무 종료일', { exact: true });
      await titleInput.fill(title);
      await start.fill(startDate);
      await end.fill(endDate);

      await page.route('**/api/workspace', async route => {
        if (!failRefresh) return route.continue();
        failRefresh = false;
        await route.fulfill({ status: 503, json: { error: '목록 조회 응답 재현' } });
      });
      await page.route('**/api/issues', async route => {
        const outgoing = route.request();
        if (outgoing.method() !== 'POST' || outgoing.postDataJSON()?.title !== title) return route.continue();
        const response = await route.fetch();
        attempts.push({ payload: outgoing.postData(), actor: outgoing.headers()['x-actor-id'], status: response.status() });
        if (attempts.length === 1) return route.abort('failed');
        if (attempts.length === 2) failRefresh = true;
        await route.fulfill({ response });
      });
      await form.getByRole('button', { name: '간트에 추가', exact: true }).click();
      const check = form.getByRole('button', { name: '업무 추가 결과 다시 확인', exact: true });
      await expect(check).toBeFocused();
      await expect(form.getByRole('alert')).toContainText('같은 요청으로 결과를 다시 확인해 주세요');
      await expect(titleInput).toBeDisabled();
      await expect(titleInput).toHaveValue(title);
      await expect(start).toHaveValue(startDate);
      await expect(end).toHaveValue(endDate);

      const confirmation = page.waitForEvent('dialog').then(async dialog => {
        await dialog.dismiss();
        expect(dialog.message()).toContain('업무가 이미 추가됐을 수 있습니다');
      });
      await form.getByRole('button', { name: '취소', exact: true }).click();
      await confirmation;
      const [saved] = (await workspace(request)).issues.filter(issue => issue.title === title);
      expect(saved).toMatchObject({ projectId: project.id, startDate, endDate });

      await check.click();
      const reloadChart = form.getByRole('button', { name: '간트 목록 다시 불러오기', exact: true });
      await expect(reloadChart).toBeFocused();
      await expect(form.getByRole('alert')).toContainText(`${saved.key} 업무를 추가했습니다`);
      await expect(start).toHaveValue(startDate);
      await expect(end).toHaveValue(endDate);
      await expect(start).toBeDisabled();

      if (removed) {
        expect((await request.delete(`/api/issues/${saved.id}`, { data: { expectedVersion: saved.version } })).ok()).toBeTruthy();
      }
      await reloadChart.click();
      if (removed) {
        await expect(form.getByRole('alert')).toContainText('간트 목록에서 결과를 확인해 주세요');
        await expect(form.getByRole('button', { name: '취소', exact: true })).toBeFocused();
        await expect(form.getByRole('button', { name: /간트에 추가|결과 다시 확인|간트 목록 다시 불러오기/u })).toHaveCount(0);
        await expect(titleInput).toBeDisabled();
        expect((await workspace(request)).issues.filter(issue => issue.title === title)).toHaveLength(0);
      } else {
        await expect(form).toHaveCount(0);
        await expect(add).toBeFocused();
        await expect(page.getByLabel(`${saved.key} 시작일`, { exact: true })).toHaveValue(startDate);
        await expect(page.getByLabel(`${saved.key} 종료일`, { exact: true })).toHaveValue(endDate);
        const bar = page.getByRole('button', { name: `${saved.key} 일정 이동`, exact: true });
        await expect(bar).toHaveCount(1);
        await bar.press('Enter');
        await expect(page.getByRole('dialog', { name: title, exact: true })).toBeVisible();
        expect(new URL(page.url()).hash).toContain('/gantt?');
        expect((await workspace(request)).issues.filter(issue => issue.title === title)).toEqual([saved]);
      }
      expect(attempts.map(({ status }) => status)).toEqual([201, 200, removed ? 409 : 200]);
      expect(attempts.map(({ payload }) => payload)).toEqual(Array(3).fill(attempts[0].payload));
      expect(attempts.map(({ actor }) => actor)).toEqual(Array(3).fill(attempts[0].actor));
      expect(attempts[0].actor).toBeTruthy();
      expect(JSON.parse(attempts[0].payload!).requestId).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u);
    } finally {
      const duplicates = (await workspace(request)).issues.filter((issue: Issue) => issue.title === title);
      for (const issue of duplicates) await request.delete(`/api/issues/${issue.id}`, { data: { expectedVersion: issue.version } });
    }
  });
}

test('간트에서 응답을 잃고 업무 목록으로 이동하면 저장된 업무를 다시 읽는다', async ({ page, request }) => {
  await page.setViewportSize({ width: 360, height: 820 });
  const project = (await workspace(request)).projects[0];
  const title = `간트에서 목록으로 ${randomUUID()}`;
  let posts = 0;
  try {
    await page.goto(`/#/${project.id}/gantt`);
    await page.getByRole('button', { name: '업무 추가', exact: true }).click();
    const form = page.getByRole('form', { name: '간트에서 업무 만들기' });
    await form.getByLabel('추가할 업무 제목', { exact: true }).fill(title);
    await page.route('**/api/issues', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      posts++;
      expect((await route.fetch()).status()).toBe(201);
      await route.abort('failed');
    });
    await form.getByRole('button', { name: '간트에 추가', exact: true }).click();
    await expect(form.getByRole('button', { name: '업무 추가 결과 다시 확인', exact: true })).toBeVisible();

    const confirmation = page.waitForEvent('dialog').then(async dialog => {
      await dialog.accept();
      expect(dialog.message()).toContain('업무가 이미 추가됐을 수 있습니다');
    });
    await page.getByRole('navigation', { name: '업무 화면', exact: true }).getByRole('button', { name: '목록 · 보드', exact: true }).click();
    await confirmation;
    await expect(page).toHaveURL(new RegExp(`/#/${project.id}/issues$`));
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    expect(posts).toBe(1);
    expect((await workspace(request)).issues.filter(issue => issue.title === title)).toHaveLength(1);
  } finally {
    const matches = (await workspace(request)).issues.filter(issue => issue.title === title);
    for (const issue of matches) await request.delete(`/api/issues/${issue.id}`, { data: { expectedVersion: issue.version } });
  }
});
